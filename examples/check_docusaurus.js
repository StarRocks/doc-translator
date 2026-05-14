#!/usr/bin/env node
/**
 * check_docusaurus.js — Docusaurus build + HTML structure comparison.
 *
 * Builds both the source and translated markdown files through the same
 * Docusaurus pipeline used in production, then compares the rendered HTML
 * structure. Catches rendering failures that static Markdown checks miss:
 * admonitions collapsing to plain text, tab panels becoming code blocks,
 * broken JSX causing build errors, etc.
 *
 * Usage:
 *   node examples/check_docusaurus.js <source.md> <translated.md>
 *
 * Exit 0 = all checks passed, exit 1 = failures found, exit 2 = usage/build error.
 */

import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCUSAURUS_DIR = path.resolve(__dirname, '../docusaurus-check');
const DOCS_DIR = path.join(DOCUSAURUS_DIR, 'docs');
const BUILD_DIR = path.join(DOCUSAURUS_DIR, 'build');

// ── HTML structure counters ───────────────────────────────────────────────────

/**
 * Count stable structural elements in rendered HTML.
 * Selectors chosen for stability across Docusaurus 3.x minor versions:
 *   - Admonitions: outer div carries theme-admonition-{type} class
 *   - Tabs:        ARIA role attributes are part of the a11y contract
 *   - Code blocks: theme-code-block class is stable public API
 *   - Others:      native HTML elements
 */
function countStructure($) {
    return {
        admonitions:   $('[class*="theme-admonition-"]').length,
        tabGroups:     $('[role="tablist"]').length,
        tabItems:      $('[role="tab"]').length,
        codeBlocks:    $('[class*="theme-code-block"]').length,
        preBlocks:     $('pre').length,
        tables:        $('table').length,
        headings:      $('h1, h2, h3, h4, h5, h6').length,
        listItems:     $('li').length,
        details:       $('details').length,
    };
}

// ── result helpers ────────────────────────────────────────────────────────────

function result(name, pass, message, details) {
    return { name, pass, message, details };
}

function compareStructure(src, trn) {
    const labels = {
        admonitions: 'Admonition blocks',
        tabGroups:   'Tab groups',
        tabItems:    'Tab items',
        codeBlocks:  'Fenced code blocks',
        preBlocks:   'Pre elements (fenced + indented)',
        tables:      'Tables',
        headings:    'Headings',
        listItems:   'List items',
        details:     'Details blocks',
    };

    return Object.entries(labels).map(([key, label]) => {
        const s = src[key];
        const t = trn[key];
        if (s === t) return result(label, true, `${s}`);

        const direction = t > s ? `+${t - s} extra` : `-${s - t} missing`;
        return result(label, false, `Expected ${s}, got ${t} (${direction})`);
    });
}

// ── build helpers ─────────────────────────────────────────────────────────────

function ensureDepsInstalled() {
    const nodeModules = path.join(DOCUSAURUS_DIR, 'node_modules');
    if (!fs.existsSync(nodeModules)) {
        console.log('Installing Docusaurus dependencies (first run)…');
        execSync('npm install', { cwd: DOCUSAURUS_DIR, stdio: 'inherit' });
    }
}

function buildDocusaurus() {
    execSync('npm run build', {
        cwd: DOCUSAURUS_DIR,
        stdio: ['ignore', 'ignore', 'pipe'],   // suppress normal output, capture stderr
    });
}

function findHtml(slug) {
    // Docusaurus writes docs/slug/index.html (trailingSlash: true)
    const p = path.join(BUILD_DIR, 'docs', slug, 'index.html');
    if (!fs.existsSync(p)) {
        throw new Error(`Built HTML not found: ${p}`);
    }
    return fs.readFileSync(p, 'utf8');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    const [, , sourceFile, translatedFile] = process.argv;

    if (!sourceFile || !translatedFile) {
        console.error('Usage: node examples/check_docusaurus.js <source.md> <translated.md>');
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

    // ── set up docs directory ────────────────────────────────────────────────
    await fs.ensureDir(DOCS_DIR);
    await fs.emptyDir(DOCS_DIR);
    await fs.copy(sourcePath, path.join(DOCS_DIR, 'source.md'));
    await fs.copy(translatedPath, path.join(DOCS_DIR, 'translated.md'));

    // ── install deps if needed ───────────────────────────────────────────────
    ensureDepsInstalled();

    // ── build ────────────────────────────────────────────────────────────────
    console.log('\nBuilding Docusaurus…');
    let buildError = null;
    try {
        buildDocusaurus();
    } catch (err) {
        buildError = err.stderr?.toString() || err.message;
    }

    console.log(`\nDocusaurus HTML check: ${path.basename(sourcePath)} → ${path.basename(translatedPath)}\n`);

    if (buildError) {
        // Surface the first ERROR line from Docusaurus output
        const firstError = buildError.split('\n').find(l => l.includes('[ERROR]')) || buildError.slice(0, 200);
        console.log(`❌  Build failed          ${firstError.trim()}`);
        console.log(`\n${'─'.repeat(60)}`);
        console.log('0/1 checks passed, 1 failed\n');
        process.exit(1);
    }

    console.log('✅  Build succeeded');

    // ── parse HTML ───────────────────────────────────────────────────────────
    const srcHtml = findHtml('source');
    const trnHtml = findHtml('translated');

    const srcCounts = countStructure(cheerio.load(srcHtml));
    const trnCounts = countStructure(cheerio.load(trnHtml));

    // ── compare ──────────────────────────────────────────────────────────────
    const checks = compareStructure(srcCounts, trnCounts);
    const longest = Math.max(...checks.map(r => r.name.length));

    let passed = 0;
    let failed = 0;

    for (const r of checks) {
        const icon = r.pass ? '✅' : '❌';
        console.log(`${icon}  ${r.name.padEnd(longest)}  ${r.message}`);
        if (!r.pass && r.details) {
            console.log(`      ${r.details}`);
        }
        if (r.pass) passed++;
        else failed++;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${passed + 1}/${checks.length + 1} checks passed${failed > 0 ? `, ${failed} failed` : ''}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(2);
});
