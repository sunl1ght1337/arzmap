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
    currentFilters: null,
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

const EMPTY_OWNER_STATS = { houseIds: [], houseCount: 0, businessIds: [], businessCount: 0 };

function isBusinessResultMode(mode) {
    return mode === 'businesses-with-houses' || mode === 'businesses-without-houses';
}

function hasHouseIdRange(filters) {
    return filters.fromId !== null || filters.toId !== null;
}

function hasBusinessIdRange(filters) {
    return filters.fromBizId !== null || filters.toBizId !== null;
}

function houseIdInRange(id, filters) {
    if (id === null || id === undefined) return false;
    if (filters.fromId !== null && id < filters.fromId) return false;
    if (filters.toId   !== null && id > filters.toId)   return false;
    return true;
}

function businessIdInRange(id, filters) {
    if (id === null || id === undefined) return false;
    if (filters.fromBizId !== null && id < filters.fromBizId) return false;
    if (filters.toBizId   !== null && id > filters.toBizId)   return false;
    return true;
}

function buildRangeOwnerStats(ownerStats, filters) {
    const statsByOwner = {};
    const houseRangeActive = hasHouseIdRange(filters);
    const businessRangeActive = hasBusinessIdRange(filters);

    for (const [owner, stats] of Object.entries(ownerStats)) {
        const houseIds = houseRangeActive
            ? stats.houseIds.filter(id => houseIdInRange(id, filters))
            : stats.houseIds;
        const businessIds = businessRangeActive
            ? stats.businessIds.filter(id => businessIdInRange(id, filters))
            : stats.businessIds;

        statsByOwner[owner] = {
            houseIds,
            houseCount: houseIds.length,
            businessIds,
            businessCount: businessIds.length,
        };
    }

    return statsByOwner;
}

function matchesResultMode(item, filters, rangeStats) {
    switch (filters.resultMode) {
        case 'houses-with-businesses':
            return Boolean(item.owner) && rangeStats.businessCount > 0;
        case 'houses-without-businesses':
            return !item.owner || rangeStats.businessCount === 0;
        case 'businesses-with-houses':
            return Boolean(item.owner) && rangeStats.houseCount > 0;
        case 'businesses-without-houses':
            return !item.owner || rangeStats.houseCount === 0;
        case 'houses-all':
        default:
            return true;
    }
}

function matchesPrimaryIdRange(item, filters) {
    return isBusinessResultMode(filters.resultMode)
        ? businessIdInRange(item.id, filters) || !hasBusinessIdRange(filters)
        : houseIdInRange(item.id, filters) || !hasHouseIdRange(filters);
}

function hasOwnerDependentFilters(filters) {
    return (
        filters.minHouses !== null || filters.maxHouses !== null ||
        filters.minBiz    !== null || filters.maxBiz    !== null ||
        Boolean(filters.nick)
    );
}

/**
 * @param {Object[]} houses        - normalised houses array
 * @param {Object[]} businesses    - normalised businesses array
 * @param {Object}   ownerStats    - built by buildOwnerStats()
 * @param {Object}   filters       - values from UI
 * @returns {Object[]} filtered items (houses or businesses, not yet enriched)
 */
function applyFilters(houses, businesses, ownerStats, filters) {
    const nickLower = filters.nick ? filters.nick.toLowerCase() : '';
    const source = isBusinessResultMode(filters.resultMode) ? businesses : houses;
    const rangeOwnerStats = buildRangeOwnerStats(ownerStats, filters);

    return source.filter(item => {
        if (!matchesPrimaryIdRange(item, filters)) return false;

        if (filters.ownerMode === 'with'    && !item.owner) return false;
        if (filters.ownerMode === 'without' &&  item.owner) return false;

        const rangeStats = item.owner ? (rangeOwnerStats[item.owner] ?? EMPTY_OWNER_STATS) : EMPTY_OWNER_STATS;
        if (!matchesResultMode(item, filters, rangeStats)) return false;

        if (item.owner) {
            if (filters.minHouses !== null && rangeStats.houseCount < filters.minHouses) return false;
            if (filters.maxHouses !== null && rangeStats.houseCount > filters.maxHouses) return false;
            if (filters.minBiz    !== null && rangeStats.businessCount < filters.minBiz) return false;
            if (filters.maxBiz    !== null && rangeStats.businessCount > filters.maxBiz) return false;

            if (nickLower && !item.owner.toLowerCase().includes(nickLower)) return false;
        } else if (hasOwnerDependentFilters(filters)) {
            return false;
        }

        return true;
    });
}

/** Attach owner stats fields to each row (for table display / CSV). */
function enrichResults(items, ownerStats, filters) {
    const primaryIdsByOwner = {};
    const isBusinessMode = isBusinessResultMode(filters.resultMode);
    const rangeOwnerStats = buildRangeOwnerStats(ownerStats, filters);

    for (const item of items) {
        if (!item.owner) continue;
        if (!primaryIdsByOwner[item.owner]) primaryIdsByOwner[item.owner] = [];
        primaryIdsByOwner[item.owner].push(item.id);
    }

    return items.map(item => {
        const s = item.owner ? (ownerStats[item.owner] ?? null) : null;
        const rangeStats = item.owner ? (rangeOwnerStats[item.owner] ?? EMPTY_OWNER_STATS) : EMPTY_OWNER_STATS;
        const primaryIds = item.owner ? (primaryIdsByOwner[item.owner] ?? []) : [];
        return {
            ...item,
            resultType: isBusinessMode ? 'business' : 'house',
            houseCount: s ? (isBusinessMode ? rangeStats.houseCount : primaryIds.length) : 0,
            houseIds:   s ? (isBusinessMode ? rangeStats.houseIds   : primaryIds) : [],
            businessCount: s ? (isBusinessMode ? primaryIds.length : rangeStats.businessCount) : 0,
            businessIds:   s ? (isBusinessMode ? primaryIds        : rangeStats.businessIds) : [],
        };
    });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
function idsSortValue(ids, dir) {
    const numericIds = ids.filter(id => id !== null && id !== undefined);
    if (!numericIds.length) {
        return dir === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    }

    return dir === 'asc'
        ? Math.min(...numericIds)
        : Math.max(...numericIds);
}

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
            case 'houseIds':
                return mul * (idsSortValue(a.houseIds, dir) - idsSortValue(b.houseIds, dir));
            case 'businessCount':
                return mul * (a.businessCount - b.businessCount);
            case 'businessIds':
                return mul * (idsSortValue(a.businessIds, dir) - idsSortValue(b.businessIds, dir));
            default:
                return 0;
        }
    });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderTable(results, filters) {
    const container = document.getElementById('table-container');

    if (!results.length) {
        container.innerHTML = '<p class="placeholder">Ничего не найдено. Попробуйте изменить фильтры.</p>';
        return;
    }

    const idHeader = isBusinessResultMode(filters.resultMode) ? 'ID бизнеса' : 'ID дома';

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
                    <th>${idHeader}</th>
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
function exportCsv(results, serverId, filters) {
    const isBusinessMode = isBusinessResultMode(filters.resultMode);
    const HEADERS = [
        isBusinessMode ? 'ID бизнеса' : 'ID дома', 'Владелец',
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
    const kind = isBusinessMode ? 'businesses' : 'houses';
    const filename = `${kind}_server_${serverId}_${dateStr}.csv`;

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
        const n = parseInt(v, 10);
        return v === '' || Number.isNaN(n) ? null : n;
    };
    return {
        resultMode: document.getElementById('filter-result-mode').value,
        fromId:    int('filter-from-id'),
        toId:      int('filter-to-id'),
        fromBizId: int('filter-from-biz-id'),
        toBizId:   int('filter-to-biz-id'),
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

    const filtered  = applyFilters(state.houses, state.businesses, state.ownerStats, filters);
    const enriched  = enrichResults(filtered, state.ownerStats, filters);
    const sorted    = sortResults(enriched, sortConfig);

    state.filteredResults = sorted;
    state.currentFilters = filters;

    updateSummary(state.houses.length, state.businesses.length, sorted);
    renderTable(sorted, filters);

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
     'filter-from-biz-id', 'filter-to-biz-id',
     'filter-min-houses', 'filter-max-houses',
     'filter-min-biz', 'filter-max-biz',
     'filter-nick'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('filter-owner').value = 'all';
    document.getElementById('filter-result-mode').value = 'houses-all';
    document.getElementById('sort-field').value   = 'id';
    document.getElementById('sort-dir').value     = 'asc';
    runFiltersAndRender();
}

function handleExport() {
    if (!state.filteredResults.length) return;
    try {
        exportCsv(state.filteredResults, state.serverId, state.currentFilters ?? readFilters());
    } catch (err) {
        alert('Ошибка при создании CSV-файла: ' + err.message);
    }
}
