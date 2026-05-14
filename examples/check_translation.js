#!/usr/bin/env node
/**
 * check_translation.js — static quality checks for translated markdown files.
 *
 * Usage:
 *   node examples/check_translation.js <source.md> <translated.md>
 *
 * Exit 0 = all checks passed, exit 1 = failures found, exit 2 = usage error.
 */

import fs from 'fs-extra';
import path from 'path';

// Terms that must appear in the translated file whenever they appear in source.
// These are a representative sample from never_translate.yaml.
const NEVER_TRANSLATE_SPOT_CHECK = [
    'StarRocks', 'Hive', 'Docker', 'Kubernetes', 'MinIO',
    'Stream Load', 'Broker Load', 'Data Cache', 'Iceberg',
];

// ── parsing helpers ───────────────────────────────────────────────────────────

function parseFrontmatter(content) {
    const m = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    return m ? m[0] : null;
}

function parseCodeBlocks(content) {
    const blocks = [];
    const lines = content.split('\n');
    let inBlock = false;
    let fenceChar = '';
    let fenceLen = 0;
    let lang = '';
    const collected = [];

    for (const line of lines) {
        const m = line.match(/^[ \t]*([`~]{3,})(\w*)/);
        if (m) {
            const ch = m[1][0];
            const len = m[1].length;
            if (!inBlock) {
                inBlock = true;
                fenceChar = ch;
                fenceLen = len;
                lang = m[2].toLowerCase();
                collected.length = 0;
            } else if (ch === fenceChar && len >= fenceLen) {
                blocks.push({ lang, lines: [...collected] });
                inBlock = false;
                fenceChar = '';
                fenceLen = 0;
                lang = '';
            }
            continue;
        }
        if (inBlock) collected.push(line);
    }
    return blocks;
}

// Returns all lines that are NOT inside a fenced code block.
function linesOutsideCode(content) {
    const result = [];
    const lines = content.split('\n');
    let inCode = false;
    let fChar = '';
    let fLen = 0;

    for (const line of lines) {
        const fm = line.match(/^[ \t]*([`~]{3,})/);
        if (fm) {
            const ch = fm[1][0];
            const len = fm[1].length;
            if (!inCode) { inCode = true; fChar = ch; fLen = len; }
            else if (ch === fChar && len >= fLen) { inCode = false; }
            continue;
        }
        if (!inCode) result.push(line);
    }
    return result;
}

function extractLinksOutsideCode(content) {
    const urls = [];
    for (const line of linesOutsideCode(content)) {
        for (const m of line.matchAll(/\]\(([^)]+)\)/g)) {
            urls.push(m[1]);
        }
    }
    return urls;
}

function extractHtmlTagsFromTableLines(content) {
    const tags = [];
    for (const line of linesOutsideCode(content)) {
        if (!line.trimStart().startsWith('|')) continue;
        for (const m of line.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g)) {
            tags.push(m[0]);
        }
    }
    return tags;
}

function extractImportLines(content) {
    const imports = [];
    for (const line of linesOutsideCode(content)) {
        if (/^import\s+\S+\s+from\s+['"]/.test(line.trim())) {
            imports.push(line.trim());
        }
    }
    return imports;
}

function countMatchingLines(content, pattern) {
    let count = 0;
    for (const line of linesOutsideCode(content)) {
        if (pattern.test(line)) count++;
    }
    return count;
}

function getCommentMarkers(lang) {
    if (['python', 'py', 'bash', 'shell', 'sh', 'zsh', 'yaml', 'yml'].includes(lang)) return ['#'];
    if (['sql', 'mysql', 'postgres', 'postgresql'].includes(lang)) return ['--', '#'];
    if (['javascript', 'js', 'typescript', 'ts', 'java', 'go', 'rust', 'scala', 'kotlin', 'c', 'cpp'].includes(lang)) return ['//'];
    return [];
}

function isCommentLine(line, lang) {
    const trimmed = line.trim();
    return getCommentMarkers(lang).some(marker => trimmed.startsWith(marker));
}

// ── individual checks ─────────────────────────────────────────────────────────

function result(name, pass, message, details) {
    return { name, pass, message, details };
}

function checkNoPlaceholderLeaks(src, trn) {
    const leaks = [...new Set([...trn.matchAll(/__MTX_\w+__/g)].map(m => m[0]))];
    if (leaks.length === 0) return result('No placeholder leaks', true, 'No __MTX_ tokens in output');
    return result('No placeholder leaks', false, `${leaks.length} placeholder(s) not restored`, leaks.join(', '));
}

function checkHeadingCount(src, trn) {
    const s = countMatchingLines(src, /^#{1,6}\s+\S/);
    const t = countMatchingLines(trn, /^#{1,6}\s+\S/);
    if (s === t) return result('Heading count', true, `${s} headings`);
    return result('Heading count', false, `Expected ${s}, got ${t}`);
}

function checkCodeBlockCount(src, trn) {
    const s = parseCodeBlocks(src).length;
    const t = parseCodeBlocks(trn).length;
    if (s === t) return result('Code block count', true, `${s} code blocks`);
    return result('Code block count', false, `Expected ${s}, got ${t}`);
}

function checkCodeBlockContent(src, trn) {
    const srcBlocks = parseCodeBlocks(src);
    const trnBlocks = parseCodeBlocks(trn);
    const failures = [];

    for (let i = 0; i < Math.min(srcBlocks.length, trnBlocks.length); i++) {
        const s = srcBlocks[i];
        const t = trnBlocks[i];
        const lang = s.lang || t.lang;

        if (s.lines.length !== t.lines.length) {
            failures.push(`Block ${i + 1} (${lang || 'no lang'}): line count ${s.lines.length} → ${t.lines.length}`);
            continue;
        }
        for (let j = 0; j < s.lines.length; j++) {
            if (isCommentLine(s.lines[j], lang)) continue;
            if (s.lines[j] !== t.lines[j]) {
                failures.push(`Block ${i + 1}, line ${j + 1}: '${s.lines[j]}' → '${t.lines[j]}'`);
            }
        }
    }

    if (failures.length === 0) return result('Code block content', true, 'Non-comment lines preserved');
    return result('Code block content', false, `${failures.length} mismatch(es)`, failures.slice(0, 5).join('\n'));
}

function checkLinkUrls(src, trn) {
    const srcUrls = extractLinksOutsideCode(src);
    const trnUrls = extractLinksOutsideCode(trn);

    if (srcUrls.length !== trnUrls.length) {
        return result('Link URL count', false, `Expected ${srcUrls.length} links, got ${trnUrls.length}`);
    }

    const mismatches = srcUrls
        .map((u, i) => (u !== trnUrls[i] ? `Link ${i + 1}: '${u}' → '${trnUrls[i]}'` : null))
        .filter(Boolean);

    if (mismatches.length === 0) return result('Link URLs', true, `${srcUrls.length} URLs preserved`);
    return result('Link URLs', false, `${mismatches.length} URL(s) changed`, mismatches.slice(0, 5).join('\n'));
}

function checkHtmlInTableCells(src, trn) {
    const srcTags = extractHtmlTagsFromTableLines(src);
    const trnTags = extractHtmlTagsFromTableLines(trn);

    const freq = arr => arr.reduce((m, v) => { m[v] = (m[v] || 0) + 1; return m; }, {});
    const srcFreq = freq(srcTags);
    const trnFreq = freq(trnTags);

    const missing = Object.entries(srcFreq)
        .filter(([tag, cnt]) => (trnFreq[tag] || 0) < cnt)
        .map(([tag, cnt]) => `${tag}: expected ${cnt}, got ${trnFreq[tag] || 0}`);

    if (missing.length === 0) return result('HTML tags in table cells', true, `${srcTags.length} tag(s) preserved`);
    return result('HTML tags in table cells', false, `${missing.length} tag(s) missing or changed`, missing.join('\n'));
}

function checkFrontmatter(src, trn) {
    const sf = parseFrontmatter(src);
    const tf = parseFrontmatter(trn);

    if (!sf && !tf) return result('Frontmatter', true, 'No frontmatter (OK)');
    if (sf && !tf) return result('Frontmatter', false, 'Source has frontmatter; translation does not');
    if (!sf && tf) return result('Frontmatter', false, 'Translation has frontmatter; source does not');
    if (sf === tf) return result('Frontmatter', true, 'Preserved exactly');
    return result('Frontmatter', false, 'Content differs', `Source:\n${sf}\nTranslated:\n${tf}`);
}

function checkImports(src, trn) {
    const si = extractImportLines(src);
    const ti = extractImportLines(trn);

    if (si.length === 0 && ti.length === 0) return result('Import statements', true, 'No imports (OK)');

    const missing = si.filter(l => !ti.includes(l));
    const extra = ti.filter(l => !si.includes(l));

    if (missing.length === 0 && extra.length === 0) return result('Import statements', true, `${si.length} import(s) preserved`);

    const details = [
        ...missing.map(l => `Missing: ${l}`),
        ...extra.map(l => `Extra:   ${l}`),
    ].join('\n');
    return result('Import statements', false, 'Mismatch', details);
}

function checkAdmonitionCount(src, trn) {
    const s = countMatchingLines(src, /^\s*:::\w/);
    const t = countMatchingLines(trn, /^\s*:::\w/);
    if (s === t) return result('Admonition markers', true, `${s} opening marker(s)`);
    return result('Admonition markers', false, `Expected ${s}, got ${t}`);
}

function checkAdmonitionIndentation(src, trn) {
    // Extract (indent, type) for every ::: line (openings and closings) outside code blocks.
    function admonitionLines(content) {
        const lines = [];
        for (const line of linesOutsideCode(content)) {
            const open = line.match(/^(\s*)(:::\w+)/);
            if (open) { lines.push({ indent: open[1].length, tag: open[2] }); continue; }
            const close = line.match(/^(\s*):::[ \t]*$/);
            if (close) { lines.push({ indent: close[1].length, tag: ':::' }); }
        }
        return lines;
    }

    const srcLines = admonitionLines(src);
    const trnLines = admonitionLines(trn);

    if (srcLines.length !== trnLines.length) {
        // Count mismatch is already caught by checkAdmonitionCount; skip here.
        return result('Admonition indentation', true, 'Skipped (count mismatch handled elsewhere)');
    }

    const failures = srcLines
        .map((s, i) => {
            const t = trnLines[i];
            if (s.indent !== t.indent) {
                return `${s.tag}: expected ${s.indent} spaces of indent, got ${t.indent}`;
            }
            return null;
        })
        .filter(Boolean);

    if (failures.length === 0) return result('Admonition indentation', true, `${srcLines.length} marker(s) correctly indented`);
    return result('Admonition indentation', false, `${failures.length} marker(s) have wrong indentation`, failures.join('\n'));
}

function checkNeverTranslateTerms(src, trn) {
    const failures = NEVER_TRANSLATE_SPOT_CHECK.filter(term => src.includes(term) && !trn.includes(term));
    if (failures.length === 0) return result('Never-translate terms', true, 'All spot-checked terms present');
    return result('Never-translate terms', false, `${failures.length} term(s) missing`, failures.join(', '));
}

function checkListItemCount(src, trn) {
    const s = countMatchingLines(src, /^\s*[-*]\s+\S/);
    const t = countMatchingLines(trn, /^\s*[-*]\s+\S/);
    if (s === t) return result('Unordered list items', true, `${s} item(s)`);
    return result('Unordered list items', false, `Expected ${s}, got ${t}`);
}

function checkTableColumnCounts(src, trn) {
    function colCounts(content) {
        const counts = [];
        for (const line of linesOutsideCode(content)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
            if (/^\|[\s|:-]+\|$/.test(trimmed)) continue; // separator row
            counts.push(trimmed.slice(1, -1).split('|').length);
        }
        return counts;
    }

    const sc = colCounts(src);
    const tc = colCounts(trn);

    if (sc.length !== tc.length) {
        return result('Table column counts', false, `Row count mismatch (${sc.length} vs ${tc.length})`);
    }

    const mismatches = sc
        .map((n, i) => (n !== tc[i] ? `Row ${i + 1}: ${n} → ${tc[i]} columns` : null))
        .filter(Boolean);

    if (mismatches.length === 0) return result('Table column counts', true, `${sc.length} row(s) OK`);
    return result('Table column counts', false, `${mismatches.length} row(s) have wrong column count`, mismatches.slice(0, 5).join('\n'));
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    const [, , sourceFile, translatedFile] = process.argv;

    if (!sourceFile || !translatedFile) {
        console.error('Usage: node examples/check_translation.js <source.md> <translated.md>');
        process.exit(2);
    }

    const sourcePath = path.resolve(sourceFile);
    const translatedPath = path.resolve(translatedFile);

    for (const [label, p] of [['Source', sourcePath], ['Translated', translatedPath]]) {
        if (!await fs.pathExists(p)) {
            console.error(`${label} file not found: ${p}`);
            process.exit(2);
        }
    }

    const src = await fs.readFile(sourcePath, 'utf8');
    const trn = await fs.readFile(translatedPath, 'utf8');

    const checks = [
        checkNoPlaceholderLeaks,
        checkHeadingCount,
        checkCodeBlockCount,
        checkCodeBlockContent,
        checkLinkUrls,
        checkHtmlInTableCells,
        checkFrontmatter,
        checkImports,
        checkAdmonitionCount,
        checkAdmonitionIndentation,
        checkNeverTranslateTerms,
        checkListItemCount,
        checkTableColumnCounts,
    ];

    const results = checks.map(fn => fn(src, trn));
    const longest = Math.max(...results.map(r => r.name.length));

    console.log(`\nTranslation check: ${path.basename(sourcePath)} → ${path.basename(translatedPath)}\n`);

    let passed = 0;
    let failed = 0;

    for (const r of results) {
        const icon = r.pass ? '✅' : '❌';
        console.log(`${icon}  ${r.name.padEnd(longest)}  ${r.message}`);
        if (!r.pass && r.details) {
            for (const line of r.details.split('\n').slice(0, 5)) {
                console.log(`      ${line}`);
            }
        }
        if (r.pass) passed++;
        else failed++;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${passed}/${results.length} checks passed${failed > 0 ? `, ${failed} failed` : ''}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(2);
});
