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

        return {
            id: cat.id,
            status,
            vertical: lookup ? lookup.vertical : null,
            sc: lookup ? lookup.sc : null,
            nsc: lookup ? lookup.nsc : null,
            level: lookup ? lookup.level : null,
            active: status === 'live' ? activeIds.has(String(cat.id)) : false,
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
const rows = [...liveRows, ...candidateRows];

fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(rows, null, 2));
console.log(`Wrote ${liveRows.length} live + ${candidateRows.length} candidate categories to data.json`);
