const path = require('path');
const fs = require('fs');

const { INCLUDED_SC_NAVIGATION_TILES_TESTED_OUT } = require('../constants');

// config.js imports TILE_SIZES from a monorepo-relative path that doesn't exist standalone.
// Stub it before requiring config.js.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === '../visual_filters/constants') {
        return path.join(__dirname, 'tile-sizes-stub.js');
    }
    return origResolve.call(this, request, ...rest);
};

// Live config/images (shipped) vs test config/images (live + not-yet-shipped candidates,
// merged into the SAME 3 files config.test.js/imageMapper.test.js/constants.test.js
// that get handed to engineering — see those files' diff against the live ones).
const { getVisualFiltersConfig } = require('../config');
const { getVisualFiltersConfig: getVisualFiltersTestConfig } = require('../config.test');

function loadImageMapper(filename) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    const cjsSrc = src.replace('export default', 'module.exports =');
    const m = new Module(path.join(__dirname, '..', filename));
    m.filename = path.join(__dirname, '..', filename);
    m.paths = Module._nodeModulePaths(path.join(__dirname, '..'));
    m._compile(cjsSrc, m.filename);
    return m.exports;
}

// imageMapper.test.js is a superset of imageMapper.js (live icons + candidate icons),
// so it covers image lookups for both live and candidate rows.
const imageMapper = loadImageMapper('imageMapper.test.js');

const categoryLookup = JSON.parse(fs.readFileSync(path.join(__dirname, 'category_lookup.json'), 'utf8'));
const activeIds = new Set(INCLUDED_SC_NAVIGATION_TILES_TESTED_OUT);

// Minimal RFC4180 CSV parser (handles quoted fields containing commas, e.g. category names).
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += c;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

const aliasCsvText = fs.readFileSync(path.join(__dirname, '..', 'metadata_alias.csv'), 'utf8');
const aliasRows = parseCsv(aliasCsvText);
const aliasHeader = aliasRows[0];
const conceptIdx = aliasHeader.indexOf('concat');
const aliasIdx = aliasHeader.indexOf('alias');
const aliasByConcat = new Map();
for (let i = 1; i < aliasRows.length; i++) {
    const r = aliasRows[i];
    if (r[conceptIdx]) aliasByConcat.set(r[conceptIdx], r[aliasIdx]);
}

function titleCaseFallback(value) {
    return value
        .split('_')
        .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
}

// Manual live-site check (see viewer/visual_filters_live_check.csv): did the
// "Select ..." visual-filters strip actually render on the category page.
const liveCheckCsvText = fs.readFileSync(path.join(__dirname, 'visual_filters_live_check.csv'), 'utf8');
const liveCheckRows = parseCsv(liveCheckCsvText);
const liveCheckHeader = liveCheckRows[0];
const lcIdIdx = liveCheckHeader.indexOf('id');
const lcFoundIdx = liveCheckHeader.indexOf('visual_filters_found');
const liveCheckById = new Map();
for (let i = 1; i < liveCheckRows.length; i++) {
    const r = liveCheckRows[i];
    if (r[lcIdIdx]) liveCheckById.set(r[lcIdIdx], r[lcFoundIdx] === 'YES');
}

// imageMapper.js sometimes keys icons by the parent SC id instead of the NSC id
// that config.js actually attaches filters to (e.g. Fashion Design's `clothing`
// icon lives under SC 441, while config.js uses NSCs 2412/2414/2416). Fall back
// to the parent SC's image map per-option when the leaf id has no entry of its own.
function buildRows(filtersConfig, status) {
    return filtersConfig.map((cat) => {
        const lookup = categoryLookup[String(cat.id)] || null;
        const ownImages = imageMapper[cat.id] || imageMapper[Number(cat.id)] || null;
        const parentImages = lookup && lookup.sc_id != null ? imageMapper[lookup.sc_id] || null : null;
        const nested = lookup && lookup.nsc ? lookup.nsc : '';

        const filters = cat.filters.map((f) => ({
            id: f.id,
            tileSize: f.tileSize || 'default',
            options: f.options.map((opt) => {
                const ownImage = ownImages ? ownImages[opt] || null : null;
                const parentImage = parentImages ? parentImages[opt] || null : null;
                const concatKey = lookup ? `${lookup.vertical}-${lookup.sc}-${nested}-${f.id}-${opt}` : null;
                const alias = concatKey ? aliasByConcat.get(concatKey) || null : null;
                return {
                    value: opt,
                    alias: alias || titleCaseFallback(opt),
                    aliasSource: alias ? 'csv' : 'fallback',
                    image: ownImage || parentImage || null,
                    imageSource: ownImage ? 'own' : parentImage ? 'parent-sc' : 'none',
                };
            }),
        }));

        const allOptions = filters.flatMap((f) => f.options);
        const resolvedCount = allOptions.filter((o) => o.image).length;
        const active = status === 'live' ? activeIds.has(String(cat.id)) : false;

        // What the actual production code predicts, per listings_sphinx
        // apps/search_perseus/src/apps/listings/experiments/serviceTilesSC/utils.js:
        //   shouldShowVisualFilters = !isTouch && (isIdTestedOut(subCategoryId) || isIdTestedOut(nestedSubCategoryId))
        // i.e. constants.js's flag list is checked on BOTH the leaf id and its parent SC id —
        // an NSC inherits the flag from its SC. This is the real gate, independent of the
        // "closed" DB status or the "hasn't shipped yet" candidate status below.
        const parentScId = lookup && lookup.level === 'NSC' ? lookup.sc_id : null;
        const codePredictsShow = activeIds.has(String(cat.id)) || (parentScId != null && activeIds.has(String(parentScId)));

        // Category status: is this leaf actually live at the taxonomy DB level
        // (sub_categories/nested_sub_categories visible + available_to_sellers,
        // walking up to the parent SC for NSCs). Independent of visual filters —
        // a candidate can still be a live category with no filters configured yet.
        const categoryStatus = lookup && typeof lookup.db_live === 'boolean'
            ? (lookup.db_live ? 'live' : 'closed')
            : null;

        // Visual filter status: candidate (not shipped) > active (verified showing
        // on the live page per visual_filters_live_check.csv) > inactive (shipped
        // but the strip doesn't actually render, or hasn't been verified). A closed
        // category is always inactive, even if the live check happened to still find
        // the strip rendering (e.g. stale rollout/caching) — DB visibility wins.
        const liveCheckFound = liveCheckById.has(String(cat.id)) ? liveCheckById.get(String(cat.id)) : null;
        const visualFilterStatus = status === 'candidate'
            ? 'candidate'
            : (categoryStatus === 'closed' ? 'inactive' : (liveCheckFound ? 'active' : 'inactive'));

        return {
            id: cat.id,
            status,
            vertical: lookup ? lookup.vertical : null,
            sc: lookup ? lookup.sc : null,
            nsc: lookup ? lookup.nsc : null,
            level: lookup ? lookup.level : null,
            url: lookup ? lookup.url : null,
            active,
            categoryStatus,
            visualFilterStatus,
            liveCheckFound,
            codePredictsShow,
            hasImages: resolvedCount === allOptions.length,
            hasPartialImages: resolvedCount > 0 && resolvedCount < allOptions.length,
            filters,
        };
    });
}

const liveConfig = getVisualFiltersConfig();
const liveIds = new Set(liveConfig.map((c) => c.id));
const candidateConfig = getVisualFiltersTestConfig().filter((c) => !liveIds.has(c.id));

const liveRows = buildRows(liveConfig, 'live');
const candidateRows = buildRows(candidateConfig, 'candidate');
const allRows = [...liveRows, ...candidateRows];

// config.js itself has a real duplicate entry for id '158' (two identical objects,
// lines 211 and 469 as of writing) — a genuine copy-paste bug in the shipped file,
// left untouched since these local files are an unmodified copy of production code.
// Dedupe for display so the viewer doesn't render the same category twice; the
// surviving row is flagged so the underlying duplication stays visible.
const idCounts = {};
allRows.forEach((r) => { idCounts[r.id] = (idCounts[r.id] || 0) + 1; });
const seenIds = new Set();
const rows = allRows.filter((r) => {
    if (seenIds.has(r.id)) return false;
    seenIds.add(r.id);
    return true;
}).map((r) => ({ ...r, duplicateCountInSource: idCounts[r.id] }));

fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(rows, null, 2));
console.log(`Wrote ${liveRows.length} live + ${candidateRows.length} candidate categories to data.json`);
