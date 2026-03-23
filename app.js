/* =====================================================================
   Arizona RP — House Owners Viewer
   All logic runs client-side. No backend, no database.
   ===================================================================== */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
    serverId: null,
    houses: [],
    businesses: [],
    ownerStats: {},
    filteredResults: [],
    loaded: false,
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    buildServerSelect();

    document.getElementById('btn-load').addEventListener('click', handleLoad);
    document.getElementById('btn-apply').addEventListener('click', runFiltersAndRender);
    document.getElementById('btn-reset').addEventListener('click', handleReset);
    document.getElementById('btn-export').addEventListener('click', handleExport);
});

function buildServerSelect() {
    const sel = document.getElementById('server-select');
    for (let i = 1; i <= 32; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `Сервер ${i}`;
        sel.appendChild(opt);
    }
    const last = localStorage.getItem('lastServer');
    if (last && Number(last) >= 1 && Number(last) <= 32) {
        sel.value = last;
    }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function fetchMap(serverId) {
    const url = `https://steep-voice-b8d7.arzmap-74f.workers.dev/api/map/${serverId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return res.json();
}

// ---------------------------------------------------------------------------
// Data normalisation
// ---------------------------------------------------------------------------

/** Normalise owner string: empty / "-" / "none" / "0" → null */
function normalizeOwner(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s || s === '-' || s.toLowerCase() === 'none' || s === '0') return null;
    return s;
}

/**
 * Extract houses and businesses from the raw API response.
 * Handles multiple possible field-name conventions.
 */
function normalizeData(raw) {
    const data = raw?.data ?? raw;

    // Recursively extract all items (objects with "id" field) from any nesting
    function extractItems(obj) {
        if (Array.isArray(obj)) return obj.flatMap(extractItems);
        if (obj && typeof obj === 'object') {
            if ('id' in obj) return [obj];
            return Object.values(obj).flatMap(extractItems);
        }
        return [];
    }

    const rawHouses = extractItems(data?.houses ?? data?.Houses ?? {});
    const rawBiz    = extractItems(data?.businesses ?? data?.Businesses ?? data?.business ?? data?.bizs ?? {});

    const houses = rawHouses.map(h => ({
        id:       (h.id ?? h.ID ?? h.houseId ?? null) !== null ? (h.id ?? h.ID ?? h.houseId) - 1 : null,
        owner:    normalizeOwner(h.owner   ?? h.Owner      ?? h.ownerName ?? h.owner_name),
        name:     String(h.name     ?? h.Name     ?? h.houseName  ?? h.house_name ?? '').trim(),
        price:    h.price    ?? h.Price    ?? null,
        interior: h.interior ?? h.Interior ?? null,
        hasAuction: h.hasAuction ?? 0,
        x: h.lx ?? h.x ?? null,
        y: h.ly ?? h.y ?? null,
    }));

    const businesses = rawBiz.map(b => ({
        id:    (b.id ?? b.ID ?? b.businessId ?? null) !== null ? (b.id ?? b.ID ?? b.businessId) - 1 : null,
        owner: normalizeOwner(b.owner ?? b.Owner    ?? b.ownerName  ?? b.owner_name),
        name:  String(b.name  ?? b.Name  ?? b.businessName ?? b.business_name ?? '').trim(),
        x: b.lx ?? b.x ?? null,
        y: b.ly ?? b.y ?? null,
    }));

    return { houses, businesses };
}

// ---------------------------------------------------------------------------
// Owner statistics
// ---------------------------------------------------------------------------

/**
 * Build a map owner → { houseIds, houseCount, businessIds, businessCount }
 * Computed once after load; reused for all filter operations.
 */
function buildOwnerStats(houses, businesses) {
    const stats = {};

    const ensure = (owner) => {
        if (!stats[owner]) {
            stats[owner] = { houseIds: [], houseCount: 0, businessIds: [], businessCount: 0 };
        }
        return stats[owner];
    };

    for (const h of houses) {
        if (!h.owner) continue;
        const s = ensure(h.owner);
        s.houseIds.push(h.id);
        s.houseCount++;
    }

    for (const b of businesses) {
        if (!b.owner) continue;
        const s = ensure(b.owner);
        s.businessIds.push(b.id);
        s.businessCount++;
    }

    return stats;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * @param {Object[]} houses        - normalised houses array
 * @param {Object}   ownerStats    - built by buildOwnerStats()
 * @param {Object}   filters       - values from UI
 * @returns {Object[]} filtered houses (not yet enriched with stats)
 */
function applyFilters(houses, ownerStats, filters) {
    const nickLower = filters.nick ? filters.nick.toLowerCase() : '';

    // Pre-compute house count per owner within the ID range
    // so that minHouses/maxHouses filter against houses in range, not total
    const rangeHouseCount = {};
    if (filters.minHouses !== null || filters.maxHouses !== null) {
        for (const h of houses) {
            if (!h.owner) continue;
            if (filters.fromId !== null && h.id !== null && h.id < filters.fromId) continue;
            if (filters.toId   !== null && h.id !== null && h.id > filters.toId)   continue;
            rangeHouseCount[h.owner] = (rangeHouseCount[h.owner] ?? 0) + 1;
        }
    }

    return houses.filter(h => {
        // ── ID range ──────────────────────────────────────────────────
        if (filters.fromId !== null && h.id !== null && h.id < filters.fromId) return false;
        if (filters.toId   !== null && h.id !== null && h.id > filters.toId)   return false;

        // ── Owner presence ────────────────────────────────────────────
        if (filters.ownerMode === 'with'    && !h.owner) return false;
        if (filters.ownerMode === 'without' &&  h.owner) return false;

        // ── Owner-dependent filters ───────────────────────────────────
        if (h.owner) {
            const inRange = rangeHouseCount[h.owner] ?? 0;
            const s = ownerStats[h.owner] ?? { businessCount: 0 };

            if (filters.minHouses !== null && inRange < filters.minHouses) return false;
            if (filters.maxHouses !== null && inRange > filters.maxHouses) return false;
            if (filters.minBiz    !== null && s.businessCount < filters.minBiz) return false;
            if (filters.maxBiz    !== null && s.businessCount > filters.maxBiz) return false;

            if (nickLower && !h.owner.toLowerCase().includes(nickLower)) return false;
        } else {
            const ownerFiltersActive =
                filters.minHouses !== null || filters.maxHouses !== null ||
                filters.minBiz    !== null || filters.maxBiz    !== null ||
                nickLower;
            if (ownerFiltersActive) return false;
        }

        return true;
    });
}

/** Attach owner stats fields to each house row (for table display / CSV).
 *  houseCount/houseIds reflect only the houses present in the filtered list.
 *  businessCount/businessIds reflect total on the server (ownerStats). */
function enrichResults(houses, ownerStats) {
    // Build house counts scoped to the current filtered list
    const rangeIds   = {};
    for (const h of houses) {
        if (!h.owner) continue;
        if (!rangeIds[h.owner]) rangeIds[h.owner] = [];
        rangeIds[h.owner].push(h.id);
    }

    return houses.map(h => {
        const s = h.owner ? (ownerStats[h.owner] ?? null) : null;
        const ids = h.owner ? (rangeIds[h.owner] ?? []) : [];
        return {
            ...h,
            houseCount:    ids.length,
            houseIds:      ids,
            businessCount: s ? s.businessCount : 0,
            businessIds:   s ? s.businessIds   : [],
        };
    });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
function sortResults(results, { field, dir }) {
    const mul = dir === 'asc' ? 1 : -1;
    return [...results].sort((a, b) => {
        switch (field) {
            case 'id':
                return mul * ((a.id ?? 0) - (b.id ?? 0));
            case 'owner': {
                const va = a.owner ?? '';
                const vb = b.owner ?? '';
                return mul * va.localeCompare(vb, 'ru');
            }
            case 'houseCount':
                return mul * (a.houseCount - b.houseCount);
            case 'businessCount':
                return mul * (a.businessCount - b.businessCount);
            default:
                return 0;
        }
    });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderTable(results) {
    const container = document.getElementById('table-container');

    if (!results.length) {
        container.innerHTML = '<p class="placeholder">Ничего не найдено. Попробуйте изменить фильтры.</p>';
        return;
    }

    const rows = results.map(r => {
        const hIds = r.houseIds.length    ? r.houseIds.join(', ')    : '—';
        const bIds = r.businessIds.length ? r.businessIds.join(', ') : '—';

        const ownerCell = r.owner
            ? `<td class="owner-cell">${esc(r.owner)}</td>`
            : `<td><span class="no-owner">—</span></td>`;

        const hCount = r.houseCount
            ? `<td class="count-cell">${r.houseCount}</td>`
            : `<td class="count-zero">—</td>`;

        const bCount = r.businessCount
            ? `<td class="count-cell">${r.businessCount}</td>`
            : `<td class="count-zero">—</td>`;

        return `<tr>
            <td>${r.id ?? '—'}</td>
            ${ownerCell}
            ${hCount}
            <td class="ids-cell">${hIds}</td>
            ${bCount}
            <td class="ids-cell">${bIds}</td>
            <td>${esc(r.name) || '<span class="no-owner">—</span>'}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>ID дома</th>
                    <th>Владелец</th>
                    <th>Домов</th>
                    <th>ID домов владельца</th>
                    <th>Бизнесов</th>
                    <th>ID бизнесов владельца</th>
                    <th>Название</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------
function exportCsv(results, serverId) {
    const HEADERS = [
        'ID дома', 'Владелец',
        'Кол-во домов', 'ID домов',
        'Кол-во бизнесов', 'ID бизнесов',
        'Название',
    ];

    const rows = results.map(r => [
        r.id ?? '',
        r.owner ?? '',
        r.houseCount,
        r.houseIds.join(' | '),
        r.businessCount,
        r.businessIds.join(' | '),
        r.name,
    ]);

    const csv = [HEADERS, ...rows]
        .map(row =>
            row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
        )
        .join('\r\n');

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
        `_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const filename = `houses_server_${serverId}_${dateStr}.csv`;

    // BOM for correct Cyrillic rendering in Excel
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setStatus(msg, type = '') {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status ' + type;
}

function updateSummary(totalHouses, totalBiz, results) {
    document.getElementById('stat-total-houses').textContent = totalHouses;
    document.getElementById('stat-total-biz').textContent    = totalBiz;
    document.getElementById('stat-results').textContent      = results.length;
    const unique = new Set(results.filter(r => r.owner).map(r => r.owner)).size;
    document.getElementById('stat-owners').textContent = unique;
}

function readFilters() {
    const int = (id) => {
        const v = document.getElementById(id).value.trim();
        return v === '' ? null : parseInt(v, 10);
    };
    return {
        fromId:    int('filter-from-id'),
        toId:      int('filter-to-id'),
        ownerMode: document.getElementById('filter-owner').value,
        minHouses: int('filter-min-houses'),
        maxHouses: int('filter-max-houses'),
        minBiz:    int('filter-min-biz'),
        maxBiz:    int('filter-max-biz'),
        nick:      document.getElementById('filter-nick').value.trim(),
    };
}

function readSortConfig() {
    return {
        field: document.getElementById('sort-field').value,
        dir:   document.getElementById('sort-dir').value,
    };
}

// ---------------------------------------------------------------------------
// Core pipeline: filter → enrich → sort → render
// ---------------------------------------------------------------------------
function runFiltersAndRender() {
    if (!state.loaded) return;

    const filters    = readFilters();
    const sortConfig = readSortConfig();

    const filtered  = applyFilters(state.houses, state.ownerStats, filters);
    const enriched  = enrichResults(filtered, state.ownerStats);
    const sorted    = sortResults(enriched, sortConfig);

    state.filteredResults = sorted;

    updateSummary(state.houses.length, state.businesses.length, sorted);
    renderTable(sorted);

    const exportBtn  = document.getElementById('btn-export');
    const exportHint = document.getElementById('export-hint');
    exportBtn.disabled = sorted.length === 0;
    exportHint.textContent = sorted.length > 0
        ? `${sorted.length} строк будет экспортировано`
        : '';
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
async function handleLoad() {
    const serverId = document.getElementById('server-select').value;
    const btn      = document.getElementById('btn-load');

    btn.disabled       = true;
    state.loaded       = false;
    document.getElementById('btn-export').disabled = true;
    document.getElementById('export-hint').textContent = '';
    setStatus('Загрузка данных...', 'loading');

    try {
        const raw = await fetchMap(serverId);
        const { houses, businesses } = normalizeData(raw);

        if (!Array.isArray(houses) || (!houses.length && !businesses.length)) {
            setStatus(
                'Данные получены, но дома и бизнесы не найдены. ' +
                'Возможно, формат ответа API изменился.',
                'warning'
            );
            btn.disabled = false;
            return;
        }

        state.serverId    = serverId;
        state.houses      = houses;
        state.businesses  = businesses;
        state.ownerStats  = buildOwnerStats(houses, businesses);
        state.loaded      = true;

        localStorage.setItem('lastServer', serverId);
        setStatus(
            `Загружено: ${houses.length} домов, ${businesses.length} бизнесов — Сервер ${serverId}`,
            'success'
        );
        runFiltersAndRender();

    } catch (err) {
        let msg;
        if (err.message.startsWith('HTTP_')) {
            const code = err.message.split('_')[1];
            msg = code === '404'
                ? `Сервер ${serverId} не найден или не существует.`
                : `Ошибка сервера API: HTTP ${code}. Попробуйте позже.`;
        } else if (
            err.name === 'TypeError' ||
            err.message.includes('fetch') ||
            err.message.includes('Failed')
        ) {
            msg =
                'Не удалось подключиться к API. ' +
                'Проверьте интернет-соединение. ' +
                'Если проблема повторяется — возможно, API временно недоступно.';
        } else if (err instanceof SyntaxError) {
            msg = 'API вернуло некорректный JSON. Попробуйте позже.';
        } else {
            msg = `Неизвестная ошибка: ${err.message}`;
        }
        setStatus(msg, 'error');
    } finally {
        btn.disabled = false;
    }
}

function handleReset() {
    ['filter-from-id', 'filter-to-id',
     'filter-min-houses', 'filter-max-houses',
     'filter-min-biz', 'filter-max-biz',
     'filter-nick'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('filter-owner').value = 'all';
    document.getElementById('sort-field').value   = 'id';
    document.getElementById('sort-dir').value     = 'asc';
    runFiltersAndRender();
}

function handleExport() {
    if (!state.filteredResults.length) return;
    try {
        exportCsv(state.filteredResults, state.serverId);
    } catch (err) {
        alert('Ошибка при создании CSV-файла: ' + err.message);
    }
}
