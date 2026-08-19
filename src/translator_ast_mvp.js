import path from 'path';

import chalk from 'chalk';
import fs from 'fs-extra';
import Slugger from 'github-slugger';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import MarkdownTranslator from './translator.js';

class AstMarkdownTranslator extends MarkdownTranslator {
    static AST_CHUNK_MAX_CHARS = 12000;

    static AST_CHUNK_MAX_ITEMS = 40;

    static AST_SPLIT_RETRY_MAX_DEPTH = 6;

    // remark-gfm makes a pipe table an actual table node, so each cell becomes its own
    // translatable item and the stringifier rebuilds the table structure. Without it the
    // whole table arrived as one item and the model had to reproduce every pipe by hand,
    // which is how a row shipped split across two lines.
    createAstParser() {
        return unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm).use(remarkMdx);
    }

    createAstStringifier() {
        return unified()
        .use(remarkFrontmatter, ['yaml'])
        .use(remarkStringify, { fences: true, bullet: '-', listItemIndent: 'one' })
        .use(remarkGfm)
        .use(remarkMdx);
    }

    buildPlaceholder(id) {
        return `__MTX_${id}__`;
    }

    buildInlineCodePlaceholder(id) {
        return this.buildProtectedPlaceholder('CODE', id);
    }

    // Protected inline fragments share one namespace and one counter: content that must
    // survive translation byte-exact (inline code, link destinations, raw HTML) is
    // swapped for one of these before the text reaches the model.
    buildProtectedPlaceholder(kind, id) {
        return `__MTX_${kind}_${id}__`;
    }

    // Placeholders substituted before parsing sit in the document as ordinary text, so
    // they must survive a parse/stringify round trip. The __MTX_…__ form does not: the
    // flanking underscores make it strong emphasis, and it comes back as **MTX_…**.
    // Every underscore here is intraword, which CommonMark never reads as emphasis.
    buildPreParsePlaceholder(kind, id) {
        return `MTX_${kind}_${id}_MTX`;
    }

    buildNeverTranslatePlaceholder(term) {
        let hash = 0;
        for (let i = 0; i < term.length; i++) {
            hash = ((hash << 5) - hash) + term.charCodeAt(i);
            hash |= 0;
        }
        return `__MTX_NEVER_${Math.abs(hash).toString(16).padStart(8, '0')}__`;
    }

    isFullyProtected(text) {
        return typeof text === 'string' && /^(?:\s*__MTX_NEVER_[0-9a-f]+(?:_\d+)?__)+\s*$/.test(text);
    }

    isSkippableTextParent(parentType) {
        return ['code', 'inlineCode', 'yaml', 'html', 'math', 'inlineMath', 'mdxjsEsm'].includes(parentType);
    }

    shouldTranslateValue(value) {
        return Boolean(value && value.trim());
    }

    escapeForRegex(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    protectNeverTranslateInText(text, replacements) {
        if (typeof text !== 'string' || !text || !Array.isArray(this.neverTranslateTerms) || this.neverTranslateTerms.length === 0) {
            return text;
        }

        let output = text;
        const sortedTerms = [...this.neverTranslateTerms].sort((a, b) => b.length - a.length);
        const termToPlaceholder = new Map(replacements.map(r => [r.value, r.placeholder]));
        const placeholderToTerm = new Map(replacements.map(r => [r.placeholder, r.value]));

        for (const term of sortedTerms) {
            if (!term) {
                continue;
            }

            const escapedTerm = this.escapeForRegex(term);
            const pattern = new RegExp(`\\b${escapedTerm}\\b`, 'g');

            // Resolve placeholder, detecting hash collisions
            let placeholder = termToPlaceholder.get(term);
            if (!placeholder) {
                placeholder = this.buildNeverTranslatePlaceholder(term);
                if (placeholderToTerm.has(placeholder) && placeholderToTerm.get(placeholder) !== term) {
                    let counter = 2;
                    const base = placeholder.slice(0, -2);
                    while (placeholderToTerm.has(`${base}_${counter}__`)) {
                        counter++;
                    }
                    placeholder = `${base}_${counter}__`;
                }
            }

            // Only register if term actually appears in this text
            const replaced = output.replace(pattern, placeholder);
            if (replaced === output) {
                continue;
            }

            if (!termToPlaceholder.has(term)) {
                termToPlaceholder.set(term, placeholder);
                placeholderToTerm.set(placeholder, term);
                replacements.push({ placeholder, value: term });
            }

            output = replaced;
        }

        return output;
    }

    validateNeverTranslatePlaceholders(translatedEntries, replacements) {
        const validPlaceholders = new Set(replacements.map(r => r.placeholder));
        const pattern = /__MTX_NEVER_[0-9a-f]{8}(?:_\d+)?__/g;
        const warnings = [];

        for (const entry of translatedEntries) {
            if (typeof entry.text !== 'string') {
                continue;
            }
            const matches = entry.text.match(pattern);
            if (!matches) {
                continue;
            }
            for (const match of matches) {
                if (!validPlaceholders.has(match)) {
                    warnings.push(`entry id ${entry.id}: corrupted placeholder ${match}`);
                }
            }
        }

        return warnings;
    }

    protectNeverTranslateEntries(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
            return { entries, replacements: [] };
        }

        const replacements = [];
        const protectedEntries = entries.map((entry) => {
            if (!entry || typeof entry.text !== 'string') {
                return entry;
            }

            return {
                ...entry,
                text: this.protectNeverTranslateInText(entry.text, replacements)
            };
        });

        return {
            entries: protectedEntries,
            replacements
        };
    }

    restoreNeverTranslateInText(text, replacements) {
        if (typeof text !== 'string' || !text || !Array.isArray(replacements) || replacements.length === 0) {
            return text;
        }

        let output = text;
        for (const item of replacements) {
            const escapedPlaceholder = item.placeholder.replaceAll('_', '\\_');
            output = output.split(item.placeholder).join(item.value);
            output = output.split(escapedPlaceholder).join(item.value);
        }

        return output;
    }

    restoreNeverTranslateEntries(entries, replacements) {
        if (!Array.isArray(entries) || entries.length === 0 || !Array.isArray(replacements) || replacements.length === 0) {
            return entries;
        }

        return entries.map((entry) => {
            if (!entry || typeof entry.text !== 'string') {
                return entry;
            }

            return {
                ...entry,
                text: this.restoreNeverTranslateInText(entry.text, replacements)
            };
        });
    }

    getCodeCommentMarkers(language) {
        if (!language) {
            return [];
        }

        const normalized = language.trim().toLowerCase();

        if (['python', 'py', 'bash', 'shell', 'sh', 'zsh', 'yaml', 'yml', 'toml', 'ini'].includes(normalized)) {
            return ['#'];
        }

        if (['sql', 'mysql', 'postgres', 'postgresql'].includes(normalized)) {
            return ['--', '#'];
        }

        if (
            [
                'javascript',
                'js',
                'typescript',
                'ts',
                'java',
                'c',
                'cpp',
                'c++',
                'go',
                'rust',
                'scala',
                'kotlin',
                'php',
                'swift'
            ].includes(normalized)
        ) {
            return ['//'];
        }

        return [];
    }

    extractTranslatableCodeComments(node, registerEntry) {
        if (!node || typeof node.value !== 'string' || !node.value) {
            return;
        }

        const markers = this.getCodeCommentMarkers(node.lang);
        if (markers.length === 0) {
            return;
        }

        const lines = node.value.split('\n');
        let changed = false;

        const escapeForRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];

            for (const marker of markers) {
                const markerPattern = escapeForRegex(marker);
                const match = line.match(new RegExp(`^(\\s*${markerPattern}\\s*)(.+)$`));
                if (!match) {
                    continue;
                }

                const commentPrefix = match[1];
                const commentText = match[2];

                if (!this.shouldTranslateValue(commentText)) {
                    continue;
                }

                registerEntry(commentText, (placeholder) => {
                    lines[index] = `${commentPrefix}${placeholder}`;
                });
                changed = true;
                break;
            }
        }

        if (changed) {
            node.value = lines.join('\n');
        }
    }

    // Applies fn to every line outside fenced code.
    mapLinesOutsideCode(content, fn) {
        let inCodeBlock = false;
        let codeFenceChar = '';
        let codeFenceLen = 0;

        return content.split('\n').map((line) => {
            const fenceMatch = line.trim().match(/^([`~]{3,})/);
            if (fenceMatch) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeFenceChar = fenceMatch[1][0];
                    codeFenceLen = fenceMatch[1].length;
                } else if (fenceMatch[1][0] === codeFenceChar && fenceMatch[1].length >= codeFenceLen) {
                    inCodeBlock = false;
                    codeFenceChar = '';
                    codeFenceLen = 0;
                }
                return line;
            }
            return inCodeBlock ? line : fn(line);
        }).join('\n');
    }

    // MDX rejects constructs plain CommonMark accepts. An autolink such as
    // <https://example.com/a/b> is read as a JSX tag and fails on the `/`, and `{`
    // opens an expression, so a Docusaurus heading id breaks the parse too. Both are
    // swapped for placeholders before parsing and restored afterwards.
    protectMdxHostileSpans(content) {
        const spans = [];
        let nextId = 1;
        const swap = (value) => {
            const placeholder = this.buildPreParsePlaceholder('RAW', nextId);
            spans.push({ placeholder, value });
            nextId += 1;
            return placeholder;
        };

        const protectedContent = this.mapLinesOutsideCode(content, line => line
        .replace(/<[a-z][a-z\d+.-]*:[^\s<>]*>/gi, swap)
        .replace(/\{#[^}\s]+\}/g, swap));

        return { content: protectedContent, spans };
    }

    // MDX reads `{` as the start of an expression, so a Docusaurus explicit heading id
    // (`## Title {#id}`) makes the parser throw - including on this tool's own output
    // once it starts emitting them. Strip them before parsing, keyed by line so they can
    // be put back on the same headings, and leave fenced code untouched.
    stripExplicitHeadingIds(content) {
        const lines = content.split('\n');
        const idsByLine = new Map();
        let inCodeBlock = false;
        let codeFenceChar = '';
        let codeFenceLen = 0;

        const stripped = lines.map((line, index) => {
            const fenceMatch = line.trim().match(/^([`~]{3,})/);
            if (fenceMatch) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeFenceChar = fenceMatch[1][0];
                    codeFenceLen = fenceMatch[1].length;
                } else if (fenceMatch[1][0] === codeFenceChar && fenceMatch[1].length >= codeFenceLen) {
                    inCodeBlock = false;
                    codeFenceChar = '';
                    codeFenceLen = 0;
                }
                return line;
            }
            if (inCodeBlock) {
                return line;
            }

            const headingMatch = line.match(/^(#{1,6}[^\n]*?)\{#([^}\s]+)\}[ \t]*$/);
            if (!headingMatch) {
                return line;
            }
            idsByLine.set(index + 1, headingMatch[2]);
            return headingMatch[1].trimEnd();
        }).join('\n');

        return { content: stripped, idsByLine };
    }

    // Concatenates the literal text of an inline subtree - used to slug a heading from
    // its source wording before translation replaces it.
    getInlineText(node) {
        if (!node) {
            return '';
        }
        if (node.type === 'text' || node.type === 'inlineCode') {
            return node.value || '';
        }
        if (Array.isArray(node.children)) {
            return node.children.map(child => this.getInlineText(child)).join('');
        }
        return '';
    }

    // Docusaurus derives heading ids with github-slugger, so anything else is a guess.
    // Measured against 952 real headings, the previous approximation disagreed on 102 of
    // them - mostly by collapsing repeated hyphens, so "License / Metering" produced
    // license-metering where the real anchor is license--metering. An emitted id that
    // differs from the natural slug breaks exactly the inbound links this is meant to
    // keep alive. The slugger instance also handles repeat headings (foo, foo-1).
    createSlugger() {
        return new Slugger();
    }

    // Inline nodes that can be rendered back into a translatable run. Anything absent
    // here still breaks the run, so images, hard breaks, and inline JSX keep their
    // previous handling.
    isInlineRunNode(node) {
        return ['text', 'inlineCode', 'strong', 'emphasis', 'delete', 'link', 'html', 'mdxJsxTextElement']
        .includes(node?.type);
    }

    hasSourceOffsets(node) {
        return Number.isInteger(node?.position?.start?.offset) && Number.isInteger(node?.position?.end?.offset);
    }

    // A node joins a run only when its whole subtree can be rendered back to Markdown.
    // Without this an unsupported descendant (an image inside a link, say) would be
    // silently dropped during serialization.
    canSerializeInlineRun(node) {
        if (!this.isInlineRunNode(node)) {
            return false;
        }
        // Inline JSX (<br />, <img />) is protected by copying its source text verbatim,
        // which only works for a leaf element whose offsets the parser recorded. One
        // with children would hide their text from the translation.
        if (node.type === 'mdxJsxTextElement') {
            return (node.children || []).length === 0 && this.hasSourceOffsets(node);
        }
        if (!Array.isArray(node.children)) {
            return true;
        }
        return node.children.every(child => this.canSerializeInlineRun(child));
    }

    // Whether a node contributes text worth translating, at any depth - a run made only
    // of code spans, links, and markup has nothing for the model to do.
    runHasTranslatableText(node) {
        if (!node) {
            return false;
        }
        if (node.type === 'text') {
            return this.shouldTranslateValue(node.value);
        }
        if (Array.isArray(node.children)) {
            return node.children.some(child => this.runHasTranslatableText(child));
        }
        return false;
    }

    // Rebuilding a destination from the decoded AST fields changes link syntax: a URL
    // containing spaces or parentheses needs angle brackets, and emitting it bare stops
    // the restored text parsing as a link at all. Copy the destination straight out of
    // the source when the parser recorded offsets, and fall back to a form that is at
    // least always parseable when it did not.
    formatLinkDestination(node, source) {
        const raw = this.sliceLinkDestination(node, source);
        if (raw !== null) {
            return raw;
        }

        const url = node.url || '';
        const destination = /[\s()<>]/.test(url) ? `<${url.replace(/([<>\\])/g, '\\$1')}>` : url;
        const title = (node.title || '').replace(/"/g, '\\"');
        return node.title ? `${destination} "${title}"` : destination;
    }

    sliceInlineSource(node, source) {
        if (typeof source !== 'string' || !this.hasSourceOffsets(node)) {
            return null;
        }
        return source.slice(node.position.start.offset, node.position.end.offset);
    }

    // A link is `[label](destination)`, and CommonMark requires `](` immediately after
    // the label, so the destination is everything between that and the closing paren.
    sliceLinkDestination(node, source) {
        if (typeof source !== 'string' || !this.hasSourceOffsets(node)) {
            return null;
        }

        const start = node.position.start.offset;
        const end = node.position.end.offset;
        if (source[end - 1] !== ')') {
            return null;
        }

        const children = node.children || [];
        const lastChild = children[children.length - 1];
        const labelEnd = this.hasSourceOffsets(lastChild) ? lastChild.position.end.offset : start + 1;
        const open = source.indexOf('](', labelEnd);
        if (open === -1 || open >= end) {
            return null;
        }

        return source.slice(open + 2, end - 1);
    }

    // Renders an inline node back to Markdown so a whole sentence survives as a single
    // translatable item. The markup itself stays visible - the model has to be able to
    // move a bold span or a link where the target language needs it, which is exactly
    // what it cannot do when each span arrives as its own fragment.
    serializeInlineRunNode(node, protect, source) {
        switch (node.type) {
            case 'text':
                return node.value || '';
            case 'inlineCode':
                return `\`${protect('CODE', node.value || '')}\``;
            case 'html':
                return protect('HTML', node.value || '');
            case 'mdxJsxTextElement':
                return protect('JSX', source.slice(node.position.start.offset, node.position.end.offset));
            case 'strong':
                return `**${this.serializeInlineRunChildren(node, protect, source)}**`;
            case 'emphasis':
                return `_${this.serializeInlineRunChildren(node, protect, source)}_`;
            case 'delete':
                return `~~${this.serializeInlineRunChildren(node, protect, source)}~~`;
            case 'link': {
                // GFM turns a bare URL in prose into a link node. Rendering that back as
                // [url](url) rewrites the author's text, so a literal is copied verbatim
                // instead - it has no display text to translate anyway.
                const raw = this.sliceInlineSource(node, source);
                if (raw !== null && !raw.startsWith('[')) {
                    return protect('URL', raw);
                }
                return `[${this.serializeInlineRunChildren(node, protect, source)}](${protect('URL', this.formatLinkDestination(node, source))})`;
            }
            default:
                return '';
        }
    }

    serializeInlineRunChildren(node, protect, source) {
        if (!Array.isArray(node.children)) {
            return '';
        }
        return node.children.map(child => this.serializeInlineRunNode(child, protect, source)).join('');
    }

    extractTranslatableContent(content) {
        const parser = this.createAstParser();
        const stringifier = this.createAstStringifier();
        const { content: headinglessContent, idsByLine } = this.stripExplicitHeadingIds(content);
        const { content: parseableContent, spans: hostileSpans } = this.protectMdxHostileSpans(headinglessContent);
        const tree = parser.parse(parseableContent);

        const entries = [];
        const inlinePlaceholders = [...hostileSpans];
        let nextId = 1;
        let nextPlaceholderId = 1;

        // Registers a fragment that must reach the output byte-exact and returns the
        // placeholder standing in for it.
        const protect = (kind, value) => {
            const placeholder = this.buildProtectedPlaceholder(kind, nextPlaceholderId);
            inlinePlaceholders.push({ placeholder, value });
            nextPlaceholderId += 1;
            return placeholder;
        };

        const registerEntry = (currentValue, assignValue) => {
            if (!this.shouldTranslateValue(currentValue)) {
                return;
            }

            const id = nextId;
            const placeholder = this.buildPlaceholder(id);
            entries.push({ id, text: currentValue });
            assignValue(placeholder);
            nextId += 1;
        };

        const processChildrenForInlineCodeContext = (node) => {
            if (!node || typeof node !== 'object' || !Array.isArray(node.children)) {
                return;
            }

            if (this.isSkippableTextParent(node.type)) {
                return;
            }

            const children = node.children;
            const rebuiltChildren = [];
            let index = 0;

            while (index < children.length) {
                const child = children[index];

                if (!this.canSerializeInlineRun(child)) {
                    rebuiltChildren.push(child);
                    index += 1;
                    continue;
                }

                const run = [];
                let hasTranslatableText = false;

                while (index < children.length) {
                    const runChild = children[index];
                    if (!this.canSerializeInlineRun(runChild)) {
                        break;
                    }

                    if (this.runHasTranslatableText(runChild)) {
                        hasTranslatableText = true;
                    }

                    run.push(runChild);
                    index += 1;
                }

                // Nothing for the model to do - leave the nodes alone so the recursion
                // below can still reach anything nested inside them.
                if (!hasTranslatableText) {
                    rebuiltChildren.push(...run);
                    continue;
                }

                const combinedText = run
                .map(runChild => this.serializeInlineRunNode(runChild, protect, parseableContent))
                .join('');

                registerEntry(combinedText, (entryPlaceholder) => {
                    rebuiltChildren.push({ type: 'text', value: entryPlaceholder });
                });
            }

            node.children = rebuiltChildren;

            for (const child of node.children) {
                processChildrenForInlineCodeContext(child);
            }
        };

        // Issue #3 §5: a translated heading changes the Docusaurus slug and silently
        // breaks every inbound #anchor. Emitting the source-language slug as an explicit
        // id keeps those links alive through any rewording. Slugs are taken before
        // extraction replaces the heading text, and the anchor itself is protected so
        // the model never sees it.
        const headingAnchors = new Map();
        if (this.emitHeadingAnchors) {
            // github-slugger suffixes a repeat as foo, foo-1, foo-2. Without that, two
            // headings with the same wording get the same id, the page carries duplicate
            // ids, and the second inbound anchor still breaks.
            const slugger = this.createSlugger();
            visit(tree, 'heading', (node) => {
                const headingText = this.getInlineText(node);
                if (!headingText.trim()) {
                    return;
                }
                // An id the author already set wins over a derived one.
                const existingId = idsByLine.get(node.position?.start?.line);
                // An author-set id wins, but still has to be reserved with the slugger
                // or a later derived slug could collide with it.
                let slug;
                if (existingId) {
                    slugger.slug(existingId);
                    slug = existingId;
                } else {
                    slug = slugger.slug(headingText);
                }
                if (slug) {
                    headingAnchors.set(node, slug);
                }
            });
        } else if (idsByLine.size > 0) {
            // --no-heading-anchors: stripExplicitHeadingIds already removed {#id} from
            // the source text so the MDX parser can handle it. Re-add author-supplied ids
            // as protected placeholders so they survive translation unchanged.
            visit(tree, 'heading', (node) => {
                const existingId = idsByLine.get(node.position?.start?.line);
                if (existingId) {
                    headingAnchors.set(node, existingId);
                }
            });
        }

        processChildrenForInlineCodeContext(tree);

        for (const [node, slug] of headingAnchors) {
            node.children.push({ type: 'text', value: protect('ANCHOR', ` {#${slug}}`) });
        }

        // Translate description and sidebar_label values in YAML frontmatter.
        // All other frontmatter keys (including their values) are preserved exactly.
        visit(tree, 'yaml', (node) => {
            for (const key of ['description', 'sidebar_label']) {
                const linePattern = new RegExp(`^(${key}:\\s*)(['"]?)(.+?)\\2\\s*$`, 'm');
                const m = node.value.match(linePattern);
                if (!m) continue;
                const [, prefix, , value] = m;
                registerEntry(value, (placeholder) => {
                    // Always double-quote so the placeholder (and later the translated
                    // value) sits inside a valid YAML quoted scalar regardless of the
                    // original quoting style. fixFrontmatterYamlQuoting handles any
                    // bare " characters the translation introduces.
                    node.value = node.value.replace(linePattern, `${prefix}"${placeholder}"`);
                });
            }
        });

        visit(tree, 'code', (node) => {
            this.extractTranslatableCodeComments(node, registerEntry);
        });

        visit(tree, 'image', (node) => {
            registerEntry(node.alt, (placeholder) => {
                node.alt = placeholder;
            });
            registerEntry(node.title, (placeholder) => {
                node.title = placeholder;
            });
        });

        visit(tree, 'link', (node) => {
            registerEntry(node.title, (placeholder) => {
                node.title = placeholder;
            });
        });

        visit(tree, 'definition', (node) => {
            registerEntry(node.title, (placeholder) => {
                node.title = placeholder;
            });
        });

        const skeleton = stringifier.stringify(tree);

        return {
            skeleton,
            entries,
            inlinePlaceholders
        };
    }

    splitEntriesForTranslation(entries) {
        const chunks = [];
        let current = [];
        let currentChars = 0;

        for (const entry of entries) {
            const entryChars = entry.text.length;

            if (
                current.length > 0 &&
                (
                    current.length >= AstMarkdownTranslator.AST_CHUNK_MAX_ITEMS ||
                    currentChars + entryChars > AstMarkdownTranslator.AST_CHUNK_MAX_CHARS
                )
            ) {
                chunks.push(current);
                current = [];
                currentChars = 0;
            }

            current.push(entry);
            currentChars += entryChars;
        }

        if (current.length > 0) {
            chunks.push(current);
        }

        return chunks;
    }

    logChunkMetadata(index, total, metadata, notes = [], status = 'info') {
        const noteText = notes.length > 0 ? `; notes: ${notes.join('; ')}` : '';
        const summary = {
            finishReason: metadata?.finishReason || undefined,
            usageMetadata: metadata?.usageMetadata || undefined,
            promptFeedback: metadata?.promptFeedback || undefined,
            safetyRatings: metadata?.safetyRatings || undefined,
            candidates: metadata?.candidates || undefined
        };

        const message = `[chunk ${index}/${total}] metadata${noteText}: ${JSON.stringify(summary)}`;
        if (status === 'success') {
            console.log(chalk.green(message));
            return;
        }
        if (status === 'failure') {
            console.log(chalk.red(message));
            return;
        }

        console.log(chalk.gray(message));
    }

    maskTraceValue(value) {
        if (typeof value !== 'string' || !value || !this.apiKey) {
            return value;
        }

        return value.split(this.apiKey).join('***');
    }

    logTraceEntries(items, translated, chunkIndex, totalChunks, sourceLanguage, targetLanguage) {
        const translatedById = new Map(translated.merged.map(item => [item.id, item.text]));
        const unresolvedIds = new Set(translated.missingIds);

        for (const item of items) {
            const translatedText = translatedById.has(item.id) ? translatedById.get(item.id) : item.text;
            const traceRecord = {
                chunk: chunkIndex,
                totalChunks,
                id: item.id,
                sourceLanguage,
                targetLanguage,
                status: unresolvedIds.has(item.id) ? 'unresolved_missing_id' : 'translated',
                sourceText: this.maskTraceValue(item.text),
                translatedText: this.maskTraceValue(translatedText)
            };

            console.log(chalk.magenta(`[trace] ${JSON.stringify(traceRecord)}`));
        }
    }

    createAstTranslationPrompt(items, targetLanguage, sourceLanguage) {
        const systemPrompt = this.renderSystemPrompt(sourceLanguage, targetLanguage);
        const payload = JSON.stringify(items);

        const userPrompt =
            `Translate each item's text from ${sourceLanguage} to ${targetLanguage}.\n\n` +
            'Response format requirements:\n' +
            '1) Return ONLY a JSON array.\n' +
            '2) Keep each id exactly as-is.\n' +
            '3) Translate only text values.\n' +
            '4) Do not add or remove items.\n' +
            '5) Do not include explanations or markdown code fences.\n' +
            '6) Tokens matching __MTX_CODE_<number>__ are protected placeholders for inline code. Keep them exactly unchanged. Do not translate, split, remove, or rename them.\n' +
            '   Likewise preserve all other __MTX_<KIND>_<number>__ tokens unchanged (__MTX_URL_*__, __MTX_HTML_*__, __MTX_JSX_*__, __MTX_ANCHOR_*__). These are byte-exact source fragments that must reach the output as-is.\n' +
            '7) Tokens matching __MTX_NEVER_<hexhash>__ (where <hexhash> is an 8-character hexadecimal string like __MTX_NEVER_3fa8c201__) are protected placeholders for never-translate terms. Copy each token character-for-character into your output. Do not alter, simplify, renumber, or replace the hex hash with any other value.\n\n' +
            `Input JSON:\n${payload}`;

        return { system: systemPrompt || null, user: userPrompt };
    }

    createAstTranslationRepairPrompt(items, targetLanguage, sourceLanguage, parseErrorMessage) {
        const { system, user } = this.createAstTranslationPrompt(items, targetLanguage, sourceLanguage);
        return {
            system,
            user: `${user}\n\nYour previous response could not be parsed as JSON (${parseErrorMessage}). Return STRICT valid JSON only.`
        };
    }

    parseJsonArrayFromModelText(text) {
        const trimmed = text.trim();

        const stripFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

        const repairInvalidEscapes = candidate => candidate.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');

        const tryParse = (candidate) => {
            const parsed = JSON.parse(candidate);
            if (!Array.isArray(parsed)) {
                throw new Error('Model response is not a JSON array');
            }
            return parsed;
        };

        try {
            return tryParse(stripFence);
        } catch {
            try {
                return tryParse(repairInvalidEscapes(stripFence));
            } catch {
                // Continue to bracket extraction fallback.
            }

            const start = stripFence.indexOf('[');
            const end = stripFence.lastIndexOf(']');
            if (start >= 0 && end > start) {
                const candidate = stripFence.slice(start, end + 1);
                try {
                    return tryParse(candidate);
                } catch {
                    return tryParse(repairInvalidEscapes(candidate));
                }
            }
            throw new Error('Unable to parse JSON array from model response');
        }
    }

    mergeAstTranslationItems(items, translatedItems) {
        const byId = new Map();
        let invalidItemCount = 0;

        for (const item of translatedItems) {
            const normalizedId = typeof item?.id === 'number' ? item.id : Number(item?.id);
            if (!Number.isInteger(normalizedId) || typeof item?.text !== 'string') {
                invalidItemCount += 1;
                continue;
            }
            byId.set(normalizedId, item.text);
        }

        const missingIds = [];
        const merged = items.map((item) => {
            if (!byId.has(item.id)) {
                missingIds.push(item.id);
                return {
                    id: item.id,
                    text: item.text
                };
            }

            return {
                id: item.id,
                text: byId.get(item.id)
            };
        });

        return {
            merged,
            missingIds,
            invalidItemCount
        };
    }

    async requestParsedAstItems(items, targetLanguage, sourceLanguage) {
        const { system, user } = this.createAstTranslationPrompt(items, targetLanguage, sourceLanguage);
        const response = await this.callModel(user, system);
        const metadata = this.extractChunkMetadata(response);
        const text = this.getResponseText(response);

        try {
            return {
                translatedItems: this.parseJsonArrayFromModelText(text),
                metadata,
                repairMetadata: null,
                parseWarnings: []
            };
        } catch (initialParseError) {
            const { system: repairSystem, user: repairUser } = this.createAstTranslationRepairPrompt(
                items,
                targetLanguage,
                sourceLanguage,
                initialParseError.message
            );
            const repairResponse = await this.callModel(repairUser, repairSystem);
            const repairMetadata = this.extractChunkMetadata(repairResponse);
            const repairText = this.getResponseText(repairResponse);

            try {
                return {
                    translatedItems: this.parseJsonArrayFromModelText(repairText),
                    metadata,
                    repairMetadata,
                    parseWarnings: [`initial parse failed: ${initialParseError.message}`]
                };
            } catch (repairParseError) {
                return {
                    translatedItems: [],
                    metadata,
                    repairMetadata,
                    parseWarnings: [
                        `initial parse failed: ${initialParseError.message}`,
                        `repair parse failed: ${repairParseError.message}`
                    ]
                };
            }
        }
    }

    async recoverMissingIdsWithSplit(items, targetLanguage, sourceLanguage, splitDepth) {
        if (items.length === 0) {
            return {
                recovered: [],
                unresolvedIds: [],
                invalidItemCount: 0
            };
        }

        if (splitDepth >= AstMarkdownTranslator.AST_SPLIT_RETRY_MAX_DEPTH || items.length === 1) {
            const leafResult = await this.translateEntryChunk(items, targetLanguage, sourceLanguage, {
                allowSplitFallback: false,
                splitDepth
            });

            const unresolvedSet = new Set(leafResult.missingIds);
            return {
                recovered: leafResult.merged.filter(item => !unresolvedSet.has(item.id)),
                unresolvedIds: leafResult.missingIds,
                invalidItemCount: leafResult.invalidItemCount
            };
        }

        const midpoint = Math.floor(items.length / 2);
        const leftItems = items.slice(0, midpoint);
        const rightItems = items.slice(midpoint);

        const leftResult = await this.recoverMissingIdsWithSplit(
            leftItems,
            targetLanguage,
            sourceLanguage,
            splitDepth + 1
        );

        const rightResult = await this.recoverMissingIdsWithSplit(
            rightItems,
            targetLanguage,
            sourceLanguage,
            splitDepth + 1
        );

        return {
            recovered: [...leftResult.recovered, ...rightResult.recovered],
            unresolvedIds: [...leftResult.unresolvedIds, ...rightResult.unresolvedIds],
            invalidItemCount: leftResult.invalidItemCount + rightResult.invalidItemCount
        };
    }

    async translateEntryChunk(items, targetLanguage, sourceLanguage, options = {}) {
        const {
            allowSplitFallback = true,
            splitDepth = 0
        } = options;

        const initialRequest = await this.requestParsedAstItems(items, targetLanguage, sourceLanguage);
        const metadata = initialRequest.metadata;
        let translatedItems = initialRequest.translatedItems;
        const parseWarnings = [...initialRequest.parseWarnings];
        const parseRecoveryMetadata = initialRequest.repairMetadata;

        const {
            merged,
            missingIds: initialMissingIds,
            invalidItemCount
        } = this.mergeAstTranslationItems(items, translatedItems);

        let resolvedMerged = merged;
        let remainingMissingIds = initialMissingIds;
        let totalInvalidItemCount = invalidItemCount;
        let finalMissingIds = remainingMissingIds;

        let retryMetadata = null;

        if (initialMissingIds.length > 0) {
            const retryItems = items.filter(item => initialMissingIds.includes(item.id));
            const retryRequest = await this.requestParsedAstItems(retryItems, targetLanguage, sourceLanguage);
            retryMetadata = retryRequest.metadata;
            translatedItems = retryRequest.translatedItems;
            parseWarnings.push(...retryRequest.parseWarnings.map(warning => `missing-id retry: ${warning}`));

            const retryMerged = this.mergeAstTranslationItems(retryItems, translatedItems);
            totalInvalidItemCount += retryMerged.invalidItemCount;

            const retryById = new Map(retryMerged.merged.map(item => [item.id, item.text]));
            resolvedMerged = resolvedMerged.map((item) => {
                if (retryById.has(item.id)) {
                    return {
                        id: item.id,
                        text: retryById.get(item.id)
                    };
                }
                return item;
            });

            remainingMissingIds = retryMerged.missingIds;
        }

        if (allowSplitFallback && finalMissingIds.length > 0 && items.length > 1) {
            const unresolvedIdsForSplit = [...finalMissingIds];
            const unresolvedItems = items.filter(item => unresolvedIdsForSplit.includes(item.id));
            const splitRecovery = await this.recoverMissingIdsWithSplit(
                unresolvedItems,
                targetLanguage,
                sourceLanguage,
                splitDepth + 1
            );

            totalInvalidItemCount += splitRecovery.invalidItemCount;

            if (splitRecovery.recovered.length > 0) {
                const recoveredById = new Map(splitRecovery.recovered.map(item => [item.id, item.text]));
                resolvedMerged = resolvedMerged.map((item) => {
                    if (recoveredById.has(item.id)) {
                        return {
                            id: item.id,
                            text: recoveredById.get(item.id)
                        };
                    }
                    return item;
                });
            }

            if (splitRecovery.recovered.length > 0 || splitRecovery.unresolvedIds.length > 0) {
                parseWarnings.push(
                    `split fallback recovered ${splitRecovery.recovered.length}/${unresolvedItems.length} missing ids`
                );
            }

            finalMissingIds = splitRecovery.unresolvedIds;
        }

        const quotePolicyMerged = this.enforceJapaneseQuotePolicy(resolvedMerged, items, targetLanguage);

        return {
            merged: quotePolicyMerged,
            metadata,
            parseRecoveryMetadata,
            retryMetadata,
            missingIds: finalMissingIds,
            invalidItemCount: totalInvalidItemCount,
            parseWarnings
        };
    }

    restoreTranslatedContent(skeleton, translatedEntries) {
        return this.restorePlaceholdersLineAware(
            skeleton,
            translatedEntries.map(entry => ({
                placeholder: this.buildPlaceholder(entry.id),
                value: entry.text
            }))
        );
    }

    // Any placeholder still present in the output means a protected fragment was never
    // restored - the content it stood for is gone.
    findPlaceholderLeaks(content) {
        const matches = content.match(/__MTX_\w+__|MTX_[A-Z]+_\d+_MTX/g) || [];
        return [...new Set(matches)];
    }

    // Checks that every inline placeholder injected during extraction is still present
    // in the translated-but-not-yet-restored content. A missing placeholder means the
    // model discarded the protected fragment (URL, raw HTML, inline JSX, heading anchor).
    // remark-stringify escapes the underscores in a placeholder that sits in the
    // skeleton, so __MTX_ANCHOR_1__ is written as \\_\\_MTX\\_ANCHOR\\_1\\_\\_. Searching only
    // for the raw form reported every heading anchor in the document as dropped -
    // 26 false alarms on a 26-heading page - while restoreInlinePlaceholders, which
    // accepts both forms, put them back correctly.
    findDroppedInlinePlaceholders(content, inlinePlaceholders) {
        return inlinePlaceholders
        .map(({ placeholder }) => placeholder)
        .filter(placeholder => !content.includes(placeholder) &&
            !content.includes(placeholder.replaceAll('_', '\\_')));
    }

    // The slugs the source headings would have produced - the ids the output must carry
    // for inbound #anchor links to keep working after the headings are translated.
    collectExpectedHeadingSlugs(content) {
        const { content: headingless, idsByLine } = this.stripExplicitHeadingIds(content);
        const { content: parseable } = this.protectMdxHostileSpans(headingless);
        const tree = this.createAstParser().parse(parseable);
        const slugger = this.createSlugger();
        const slugs = [];

        visit(tree, 'heading', (node) => {
            const headingText = this.getInlineText(node);
            if (!headingText.trim()) {
                return;
            }
            const existingId = idsByLine.get(node.position?.start?.line);
            if (existingId) {
                slugger.slug(existingId);
                slugs.push(existingId);
            } else {
                slugs.push(slugger.slug(headingText));
            }
        });

        return slugs;
    }

    collectHeadingIds(content) {
        const ids = [];
        this.mapLinesOutsideCode(content, (line) => {
            // Headings nested inside a JSX block carry that block's indentation, and the
            // expectation side reads them from the AST, so anchoring at column 0 here
            // reported a correctly emitted anchor as missing.
            const match = line.match(/^[ \t]*#{1,6}[^\n]*?\{#([^}\s]+)\}[ \t]*$/);
            if (match) {
                ids.push(match[1]);
            }
            return line;
        });
        return ids;
    }

    // Verifying the anchors end to end, the way the first clean CI run was checked by
    // hand: every source heading's slug must appear as an explicit id in the output. A
    // dropped or altered one breaks exactly the inbound links the feature exists to
    // keep alive, and nothing else notices - heading counts still match.
    findHeadingAnchorFailures(sourceContent, translatedContent) {
        if (!this.emitHeadingAnchors) {
            return [];
        }

        const expected = this.collectExpectedHeadingSlugs(sourceContent);
        const actual = new Set(this.collectHeadingIds(translatedContent));
        const missing = expected.filter(slug => !actual.has(slug));

        if (missing.length === 0) {
            return [];
        }
        const shown = missing.slice(0, 5).map(slug => `{#${slug}}`).join(', ');
        return [`translated headings are missing ${missing.length} source anchor(s): ${shown}` +
            `${missing.length > 5 ? ', …' : ''}`];
    }

    // Structural checks that run against every real translation, not just the fixture.
    // A table problem the source already has is not a translation defect, so only
    // problems the translation introduced are reported.
    findStructuralFailures(sourceContent, translatedContent) {
        const failures = [];

        // Compare per kind, not by total. A source with one trailing-pipe problem and a
        // translation with one split row have the same count, so an aggregate check
        // lets a translation defect hide behind an unrelated source defect.
        const problemKind = message => message.replace(/\d+/g, 'N');
        const sourceByKind = new Map();
        for (const problem of this.findTableStructureProblems(sourceContent)) {
            const kind = problemKind(problem.message);
            sourceByKind.set(kind, (sourceByKind.get(kind) || 0) + 1);
        }

        const seenByKind = new Map();
        for (const problem of this.findTableStructureProblems(translatedContent)) {
            const kind = problemKind(problem.message);
            const seen = (seenByKind.get(kind) || 0) + 1;
            seenByKind.set(kind, seen);
            if (seen > (sourceByKind.get(kind) || 0)) {
                failures.push(`line ${problem.line}: ${problem.message}`);
            }
        }

        for (const placeholder of this.findPlaceholderLeaks(translatedContent)) {
            failures.push(`unrestored placeholder ${placeholder}`);
        }

        failures.push(...this.findHeadingAnchorFailures(sourceContent, translatedContent));

        // Output the parser cannot read will not build either. Only report it when the
        // source itself parsed, so an input this tool never supported is not blamed on
        // the translation.
        if (this.parseFailureMessage(sourceContent) === null) {
            const message = this.parseFailureMessage(translatedContent);
            if (message !== null) {
                failures.push(`translated output no longer parses as MDX: ${message}`);
            }
        }

        return failures;
    }

    parseFailureMessage(content) {
        try {
            const { content: parseableContent } = this.protectMdxHostileSpans(content);
            this.createAstParser().parse(parseableContent);
            return null;
        } catch (error) {
            return error.message;
        }
    }

    // Issue #3 §5: fragment-level translation invited clauses coming back twice. A run
    // of at least minLength characters repeating inside one item is the signature.
    // Heuristic, so it warns rather than failing.
    findRepeatedSubstring(text, minLength) {
        for (let i = 0; i + minLength <= text.length; i++) {
            const candidate = text.slice(i, i + minLength);
            if (candidate.trim().length < minLength) {
                continue;
            }
            if (text.indexOf(candidate, i + minLength) !== -1) {
                return candidate;
            }
        }
        return null;
    }

    findDuplicatedSegments(translatedEntries, minLength = 20) {
        const warnings = [];

        for (const entry of translatedEntries) {
            const text = (entry.text || '').trim();
            // Multi-line items are whole tables (pipe tables are not parsed as tables
            // here), where repeated delimiter runs are expected rather than suspicious.
            if (text.includes('\n') || text.length < minLength * 2) {
                continue;
            }
            // A never-translate term legitimately appears twice in one sentence, and its
            // placeholder is long enough to look like a repeated clause on its own.
            const repeated = this.findRepeatedSubstring(text.replace(/__MTX_\w+__|MTX_[A-Z]+_\d+_MTX/g, ' '), minLength);
            if (repeated) {
                warnings.push(`entry id ${entry.id} repeats "${repeated}"`);
            }
        }

        return warnings;
    }

    // Issue #3 §5: one page rendered the same UI label three different ways. Identical
    // short source strings should map to identical translations within a file; long
    // prose legitimately varies with context, so only short strings are compared.
    groupTranslationsBySource(sourceEntries, translatedEntries, maxSourceLength) {
        const translationById = new Map(translatedEntries.map(entry => [entry.id, entry.text]));
        const variantsBySource = new Map();

        for (const entry of sourceEntries) {
            const translation = translationById.get(entry.id);
            if (translation === undefined) {
                continue;
            }
            const source = (entry.text || '').trim();
            if (source.length === 0 || source.length > maxSourceLength) {
                continue;
            }
            if (!variantsBySource.has(source)) {
                variantsBySource.set(source, new Set());
            }
            variantsBySource.get(source).add(translation.trim());
        }

        return variantsBySource;
    }

    // Maps every full-width mark to its ASCII counterpart, so two renderings that differ
    // only in punctuation width collapse to the same string.
    normalizePunctuationWidth(text) {
        const fullWidth = '：；！？（）［］，。、';
        const halfWidth = ':;!?()[],..';
        return [...text].map((character) => {
            const index = fullWidth.indexOf(character);
            return index === -1 ? character : halfWidth[index];
        }).join('');
    }

    // Issue #3 §5: one page rendered the same UI label three different ways. Identical
    // short source strings should map to identical translations within a file; long
    // prose legitimately varies with context, so only short strings are compared.
    // Renderings differing only in punctuation width are reported separately by
    // findPunctuationWidthInconsistencies - that is an unambiguous defect, where a
    // wording difference is often just a heading reading as a noun and a step as a verb.
    findGlossaryInconsistencies(sourceEntries, translatedEntries, maxSourceLength = 60) {
        const warnings = [];

        for (const [source, variants] of this.groupTranslationsBySource(sourceEntries, translatedEntries, maxSourceLength)) {
            if (variants.size <= 1) {
                continue;
            }
            const normalized = new Set([...variants].map(v => this.normalizePunctuationWidth(v)));
            if (normalized.size <= 1) {
                continue;
            }
            const rendered = [...variants].map(variant => `"${variant}"`).join(', ');
            warnings.push(`"${source}" was translated ${variants.size} different ways: ${rendered}`);
        }

        return warnings;
    }

    // Mixed half-width and full-width forms of the same mark inside one document, which
    // the CJK punctuation rule in the system prompt forbids. Unlike a wording
    // difference this is never legitimate, so it is worth calling out on its own.
    findPunctuationWidthInconsistencies(sourceEntries, translatedEntries, maxSourceLength = 60) {
        const warnings = [];

        for (const [source, variants] of this.groupTranslationsBySource(sourceEntries, translatedEntries, maxSourceLength)) {
            if (variants.size <= 1) {
                continue;
            }
            const normalized = new Set([...variants].map(v => this.normalizePunctuationWidth(v)));
            if (normalized.size > 1) {
                continue;
            }
            const rendered = [...variants].map(variant => `"${variant}"`).join(' vs ');
            warnings.push(`"${source}" mixes punctuation widths: ${rendered}`);
        }

        return warnings;
    }

    // Structural validation for pipe tables. A dropped leading or trailing pipe is the
    // failure that has actually shipped (markdownlint MD055/MD056 caught it downstream
    // after this code did not), so these are errors, not warnings, and the caller fails
    // the run on them.
    findTableStructureProblems(content) {
        const lines = content.split('\n');
        const problems = [];
        let expectedCols = null;
        let inCodeBlock = false;
        let codeFenceChar = '';
        let codeFenceLen = 0;

        lines.forEach((line, index) => {
            const trimmed = line.trim();
            const lineNumber = index + 1;

            const fenceMatch = trimmed.match(/^([`~]{3,})/);
            if (fenceMatch) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeFenceChar = fenceMatch[1][0];
                    codeFenceLen = fenceMatch[1].length;
                } else if (fenceMatch[1][0] === codeFenceChar && fenceMatch[1].length >= codeFenceLen) {
                    inCodeBlock = false;
                    codeFenceChar = '';
                    codeFenceLen = 0;
                }
                expectedCols = null;
                return;
            }
            if (inCodeBlock) {
                return;
            }

            // A blank line ends the table; anything after it is unrelated content.
            if (trimmed === '') {
                expectedCols = null;
                return;
            }

            if (!trimmed.startsWith('|')) {
                // A non-blank line directly under a table row is precisely a dropped
                // leading pipe - the row was emitted as two lines.
                if (expectedCols !== null) {
                    problems.push({
                        line: lineNumber,
                        message: 'table row is missing its leading "|"'
                    });
                    expectedCols = null;
                }
                return;
            }

            if (/^\|(?:[\s:]*-[\s:-]*\|)+$/.test(trimmed)) {
                const separatorCols = (trimmed.match(/(?<!\\)\|/g) || []).length - 1;
                // The header row set expectedCols one line earlier. Overwriting it
                // without comparing hid a header with the wrong number of cells: a
                // two-column table whose header became "| A B |" reported nothing.
                if (expectedCols !== null && expectedCols !== separatorCols) {
                    problems.push({
                        line: lineNumber - 1,
                        message: `table header has ${expectedCols} column(s) but its separator has ${separatorCols}`
                    });
                }
                expectedCols = separatorCols;
                return;
            }

            const endsWithPipe = /(?<!\\)\|$/.test(trimmed);
            if (!endsWithPipe) {
                problems.push({
                    line: lineNumber,
                    message: 'table row is missing its trailing "|"'
                });
            }

            const body = endsWithPipe ? trimmed.slice(1, -1) : trimmed.slice(1);
            const cells = body.split(/(?<!\\)\|/);

            if (expectedCols === null) {
                expectedCols = cells.length;
                return;
            }
            if (cells.length !== expectedCols) {
                problems.push({
                    line: lineNumber,
                    message: `table row has ${cells.length} column(s), expected ${expectedCols}`
                });
            }
        });

        return problems;
    }

    fixAdmonitionIndentation(content) {
        const lines = content.split('\n');
        const result = [];
        const admonitionStack = [];
        let inCodeBlock = false;
        let codeFenceChar = null;
        let codeFenceLen = 0;

        for (const line of lines) {
            const fenceMatch = line.match(/^\s*([`~]{3,})/);
            if (fenceMatch) {
                const fenceChar = fenceMatch[1][0];
                const fenceLen = fenceMatch[1].length;
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeFenceChar = fenceChar;
                    codeFenceLen = fenceLen;
                } else if (fenceChar === codeFenceChar && fenceLen >= codeFenceLen) {
                    inCodeBlock = false;
                    codeFenceChar = null;
                    codeFenceLen = 0;
                }
                result.push(line);
                continue;
            }

            if (inCodeBlock) {
                result.push(line);
                continue;
            }

            const openMatch = line.match(/^(\s*):::\w/);
            const closeMatch = !openMatch && line.match(/^(\s*):::[ \t]*$/);

            if (openMatch) {
                admonitionStack.push(openMatch[1].length);
                result.push(line);
            } else if (closeMatch && admonitionStack.length > 0) {
                const expectedIndent = admonitionStack[admonitionStack.length - 1];
                const actualIndent = closeMatch[1].length;
                result.push(actualIndent < expectedIndent ?
                    `${' '.repeat(expectedIndent)}:::` :
                    line);
                admonitionStack.pop();
            } else if (admonitionStack.length > 0 && line.trim() !== '') {
                const expectedIndent = admonitionStack[admonitionStack.length - 1];
                const actualIndent = line.length - line.trimStart().length;
                result.push(actualIndent < expectedIndent ?
                    `${' '.repeat(expectedIndent)}${line.trimStart()}` :
                    line);
            } else {
                result.push(line);
            }
        }

        return result.join('\n');
    }

    // Removes the cosmetic indentation models add to the children of a JSX block
    // (<Tabs>, <TabItem>, <details>). An indent shared by every line of a block is a
    // uniform prefix rather than structure, so removing it preserves relative nesting:
    // a list or fenced block indented further inside the block keeps its extra indent.
    // Blocks are dedented as they close, so an inner block is normalized before the
    // block containing it.
    fixJsxBlockIndentation(content) {
        const lines = content.split('\n');
        const stack = [];
        let inCodeBlock = false;
        let codeFenceChar = '';
        let codeFenceLen = 0;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trimStart();

            const fenceMatch = trimmed.match(/^([`~]{3,})/);
            if (fenceMatch) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeFenceChar = fenceMatch[1][0];
                    codeFenceLen = fenceMatch[1].length;
                } else if (fenceMatch[1][0] === codeFenceChar && fenceMatch[1].length >= codeFenceLen) {
                    inCodeBlock = false;
                    codeFenceChar = '';
                    codeFenceLen = 0;
                }
                continue;
            }
            if (inCodeBlock) {
                continue;
            }

            const top = stack.length > 0 ? stack[stack.length - 1] : null;
            if (top && new RegExp(`^<\\/${top.tag}\\b`).test(trimmed)) {
                stack.pop();
                this.dedentJsxBlockBody(lines, top.startIndex, i, top.openerIndent);
                // The model sometimes indents the closer to match preceding list content,
                // which makes MDX read it as list continuation rather than a JSX closer.
                lines[i] = `${' '.repeat(top.openerIndent)}${trimmed}`;
                continue;
            }

            const openerMatch = lines[i].match(/^(\s*)<(Tabs|TabItem|details)[\s>]/);
            if (openerMatch && !lines[i].trimEnd().endsWith('/>')) {
                stack.push({
                    tag: openerMatch[2],
                    openerIndent: openerMatch[1].length,
                    startIndex: i
                });
            }
        }

        return this.separateJsxClosers(lines).join('\n');
    }

    // Strips the indentation shared by every non-empty line between a JSX opener and its
    // closer, down to the opener's own indentation.
    dedentJsxBlockBody(lines, startIndex, endIndex, openerIndent) {
        let sharedIndent = null;
        for (let i = startIndex + 1; i < endIndex; i++) {
            const trimmed = lines[i].trimStart();
            if (trimmed.length === 0) {
                continue;
            }
            const indent = lines[i].length - trimmed.length;
            sharedIndent = sharedIndent === null ? indent : Math.min(sharedIndent, indent);
        }

        const extra = sharedIndent === null ? 0 : sharedIndent - openerIndent;
        if (extra <= 0) {
            return;
        }

        for (let i = startIndex + 1; i < endIndex; i++) {
            if (lines[i].trimStart().length > 0) {
                lines[i] = lines[i].slice(extra);
            }
        }
    }

    // Ensures a blank line precedes every JSX closer so it is not swallowed by a
    // preceding list, paragraph, or admonition block.
    separateJsxClosers(lines) {
        const result = [];
        let inCodeBlock = false;
        let codeFenceChar = '';
        let codeFenceLen = 0;

        for (const line of lines) {
            const trimmed = line.trimStart();

            const fenceMatch = trimmed.match(/^([`~]{3,})/);
            if (fenceMatch) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeFenceChar = fenceMatch[1][0];
                    codeFenceLen = fenceMatch[1].length;
                } else if (fenceMatch[1][0] === codeFenceChar && fenceMatch[1].length >= codeFenceLen) {
                    inCodeBlock = false;
                    codeFenceChar = '';
                    codeFenceLen = 0;
                }
                result.push(line);
                continue;
            }

            if (!inCodeBlock &&
                /^<\/(?:Tabs|TabItem|details)\b/.test(trimmed) &&
                result.length > 0 &&
                result[result.length - 1].trim() !== '') {
                result.push('');
            }
            result.push(line);
        }

        return result;
    }

    fixHtmlTableNewlines(content) {
        // The MDX stringifier inserts a blank line between sibling JSX/HTML block
        // elements. Inside an HTML <table> this creates a blank line between
        // </thead> and <tbody> (and similar pairs), which terminates the CommonMark
        // HTML block so that indented content after the gap is treated as code blocks.
        // Collapse those spurious blank lines between HTML table structural tags.
        const TABLE_TAGS = 'table|thead|tbody|tfoot|tr|th|td|colgroup|col|caption';
        const pattern = new RegExp(
            `([ \\t]*<\\/?(?:${TABLE_TAGS})[^>]*>)\\n\\n([ \\t]*<)`,
            'g'
        );
        // Loop until stable: each pass collapses one layer of consecutive gaps,
        // so three or more adjacent structural elements need more than two passes.
        let result = content;
        let prev;
        do {
            prev = result;
            result = result.replace(pattern, '$1\n$2');
        } while (result !== prev);
        return result;
    }

    fixFrontmatterYamlQuoting(content) {
        // description and sidebar_label are always wrapped in double quotes by the
        // extractor so the placeholder sits safely inside a quoted scalar. After the
        // translated text is restored into those quotes, any literal " characters
        // introduced by the translation would produce malformed YAML. Re-escape them.
        return content.replace(
            /^(---\n[\s\S]*?\n---)/m,
            fm => fm.replace(
                /^((description|sidebar_label):\s*)"([\s\S]*?)"([ \t]*)$/gm,
                (_, pre, _key, inner, trail) => {
                    // Preserve existing \" sequences, escape any remaining bare "
                    const safe = inner
                    .split('\\"').join('\x00')
                    .split('"').join('\\"')
                    .split('\x00').join('\\"');
                    return `${pre}"${safe}"${trail}`;
                }
            )
        );
    }

    // Puts every protected fragment back: inline code bodies, link destinations, and
    // raw HTML spans all share this one restore step.
    // A pipe inside restored content splits the cell it lands in, because whatever hid
    // it - a placeholder, or an entry extracted before stringify - kept it away from the
    // stringifier: the table was written cleanly and the pipe arrives afterwards. GFM
    // unescapes \\| inside a table cell, including within a code span, so escaping here
    // reproduces the original character while keeping the row intact.
    escapeTablePipes(value) {
        return value.replace(/(?<!\\)\|/g, '\\|');
    }

    // Restores placeholder→value pairs a line at a time, so a value landing in a table
    // row can have its pipes escaped while the same value elsewhere stays untouched.
    restorePlaceholdersLineAware(content, items) {
        if (items.length === 0) {
            return content;
        }

        const prepared = items.map(item => ({
            placeholder: item.placeholder,
            escapedPlaceholder: item.placeholder.replaceAll('_', '\\_'),
            value: item.value || ''
        }));

        let inCodeBlock = false;
        let codeFenceChar = '';
        let codeFenceLen = 0;

        return content.split('\n').map((line) => {
            const fenceMatch = line.trim().match(/^([`~]{3,})/);
            if (fenceMatch) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeFenceChar = fenceMatch[1][0];
                    codeFenceLen = fenceMatch[1].length;
                } else if (fenceMatch[1][0] === codeFenceChar && fenceMatch[1].length >= codeFenceLen) {
                    inCodeBlock = false;
                    codeFenceChar = '';
                    codeFenceLen = 0;
                }
                return line;
            }

            if (!line.includes('MTX')) {
                return line;
            }

            const isTableRow = !inCodeBlock && line.trim().startsWith('|');
            let output = line;
            for (const item of prepared) {
                if (!output.includes(item.placeholder) && !output.includes(item.escapedPlaceholder)) {
                    continue;
                }
                const value = isTableRow ? this.escapeTablePipes(item.value) : item.value;
                output = output.split(item.placeholder).join(value);
                output = output.split(item.escapedPlaceholder).join(value);
            }
            return output;
        }).join('\n');
    }

    // Reverse creation order, because a placeholder made earlier can be nested inside
    // one made later: inline code containing an autolink becomes MTX_RAW_1_MTX first,
    // and that value is then stored behind __MTX_CODE_2__. Restoring in creation order
    // looks for RAW while it is still hidden inside CODE, and leaves the token behind.
    restoreInlinePlaceholders(content, inlinePlaceholders) {
        return this.restorePlaceholdersLineAware(content, [...inlinePlaceholders].reverse());
    }

    isEnglishTarget(targetLanguage) {
        if (!targetLanguage) {
            return false;
        }

        const normalized = targetLanguage.toString().trim().toLowerCase();
        return normalized === 'en' || normalized.includes('english');
    }

    isJapaneseTarget(targetLanguage) {
        if (!targetLanguage) {
            return false;
        }

        const normalized = targetLanguage.toString().trim().toLowerCase();
        return normalized === 'ja' || normalized.includes('japanese');
    }

    sourceHasExplicitQuotePair(text) {
        if (typeof text !== 'string' || !text) {
            return false;
        }

        if (text.includes('「') || text.includes('」')) {
            return true;
        }

        return /"[^"\n]+"|'[^'\n]+'/.test(text);
    }

    enforceJapaneseQuotePolicy(mergedItems, sourceItems, targetLanguage) {
        if (!this.isJapaneseTarget(targetLanguage) || !Array.isArray(mergedItems) || !Array.isArray(sourceItems)) {
            return mergedItems;
        }

        const sourceById = new Map(sourceItems.map(item => [item.id, item.text]));

        return mergedItems.map((item) => {
            if (!item || typeof item.text !== 'string') {
                return item;
            }

            const sourceText = sourceById.get(item.id) || '';
            if (this.sourceHasExplicitQuotePair(sourceText)) {
                return item;
            }

            if (!item.text.includes('「') && !item.text.includes('」')) {
                return item;
            }

            return {
                id: item.id,
                text: item.text.replaceAll('「', '').replaceAll('」', '')
            };
        });
    }

    // Cosmetic pass, so a document this parser cannot read must not sink a translation
    // that is otherwise complete - findStructuralFailures reports unparseable output
    // separately, with the parser's own message.
    normalizeEnglishInlineCodeSpacing(content) {
        try {
            return this.applyEnglishInlineCodeSpacing(content);
        } catch (error) {
            console.warn(chalk.yellow(`[spacing] skipped inline-code spacing pass: ${error.message}`));
            return content;
        }
    }

    applyEnglishInlineCodeSpacing(content) {
        const parser = this.createAstParser();
        const stringifier = this.createAstStringifier();
        const { content: parseableContent, spans } = this.protectMdxHostileSpans(content);
        const tree = parser.parse(parseableContent);

        const shouldAddTrailingSpace = value => /[a-z0-9]$/i.test(value) && !/\s$/.test(value);
        const shouldAddLeadingSpace = value => /^[a-z0-9]/i.test(value) && !/^\s/.test(value);

        visit(tree, node => Array.isArray(node?.children), (node) => {
            for (let index = 0; index < node.children.length; index += 1) {
                const child = node.children[index];
                if (child?.type !== 'inlineCode') {
                    continue;
                }

                const previous = node.children[index - 1];
                if (previous?.type === 'text' && previous.value && shouldAddTrailingSpace(previous.value)) {
                    previous.value += ' ';
                }

                const next = node.children[index + 1];
                if (next?.type === 'text' && next.value && shouldAddLeadingSpace(next.value)) {
                    next.value = ` ${next.value}`;
                }
            }
        });

        const normalized = this.restoreInlinePlaceholders(stringifier.stringify(tree), spans);
        return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
    }

    async translateMarkdownAstMvp(
        content,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false,
        trace = false
    ) {
        const { skeleton, entries, inlinePlaceholders } = this.extractTranslatableContent(content);
        const {
            entries: protectedEntries,
            replacements: neverTranslateReplacements
        } = this.protectNeverTranslateEntries(entries);

        if (protectedEntries.length === 0) {
            return content;
        }

        const entriesToTranslate = protectedEntries.filter(e => !this.isFullyProtected(e.text));
        const preTranslatedEntries = protectedEntries.filter(e => this.isFullyProtected(e.text));

        const chunks = this.splitEntriesForTranslation(entriesToTranslate);
        const translatedEntries = [...preTranslatedEntries];
        let passedChunks = 0;
        let failedChunks = 0;
        let parseRepairCount = 0;
        let missingIdRetryCount = 0;
        let fallbackChunkCount = 0;
        let fallbackItemCount = 0;

        for (let index = 0; index < chunks.length; index += 1) {
            if (progressCallback) {
                progressCallback(index + 1, chunks.length);
            }

            const items = chunks[index];
            // eslint-disable-next-line no-await-in-loop
            const translated = await this.translateEntryChunk(items, targetLanguage, sourceLanguage);
            translatedEntries.push(...translated.merged);

            if (trace) {
                this.logTraceEntries(items, translated, index + 1, chunks.length, sourceLanguage, targetLanguage);
            }

            const translatedCount = items.length - translated.missingIds.length;
            const hasMissingIds = translated.missingIds.length > 0;
            const completenessStatus = !hasMissingIds ? '✅ PASS' : '❌ FAIL';
            const details = [];

            if (translated.parseRecoveryMetadata) {
                parseRepairCount += 1;
            }
            if (translated.retryMetadata) {
                missingIdRetryCount += 1;
            }

            if (hasMissingIds) {
                details.push(`missing ids: ${translated.missingIds.join(', ')}`);
                fallbackChunkCount += 1;
                fallbackItemCount += translated.missingIds.length;
            }
            if (translated.invalidItemCount > 0) {
                details.push(`invalid items ignored: ${translated.invalidItemCount}`);
            }

            if (hasMissingIds) {
                failedChunks += 1;
            } else {
                passedChunks += 1;
            }

            if (logChunkMetadata) {
                const notes = [];
                if (translated.missingIds.length > 0) {
                    notes.push(`missing ids after retry: ${translated.missingIds.join(', ')}`);
                }
                if (translated.invalidItemCount > 0) {
                    notes.push(`invalid items ignored: ${translated.invalidItemCount}`);
                }
                if (translated.parseWarnings.length > 0) {
                    notes.push(...translated.parseWarnings);
                }

                const metadataStatus = notes.some(note => note.includes('split fallback recovered')) ? 'success' : 'info';
                this.logChunkMetadata(index + 1, chunks.length, translated.metadata, notes, metadataStatus);

                if (translated.parseRecoveryMetadata) {
                    this.logChunkMetadata(index + 1, chunks.length, translated.parseRecoveryMetadata, ['json repair retry']);
                }

                if (translated.retryMetadata) {
                    this.logChunkMetadata(index + 1, chunks.length, translated.retryMetadata, ['retry for missing ids']);
                }
            }

            const completenessMessage =
                `[chunk ${index + 1}/${chunks.length}] AST completeness check: ` +
                `Translated IDs ${translatedCount}/${items.length} - ${completenessStatus}` +
                `${details.length > 0 ? ` (${details.join('; ')})` : ''}`;

            console.log(hasMissingIds ? chalk.red(completenessMessage) : chalk.green(completenessMessage));
        }

        const chunkSummaryStatus = failedChunks === 0 ? 'PASS' : 'FAIL';
        const summaryMessage =
            `[AST per-chunk summary] check=translated_ids status=${chunkSummaryStatus} ` +
            `(passed: ${passedChunks}, failed: ${failedChunks}, total: ${chunks.length})`;
        console.log(failedChunks === 0 ? chalk.green(summaryMessage) : chalk.red(summaryMessage));
        console.log(
            chalk.gray(`[AST health] parse_repairs=${parseRepairCount} ` +
            `missing_id_retries=${missingIdRetryCount} ` +
            `fallback_chunks=${fallbackChunkCount} fallback_items=${fallbackItemCount}`)
        );

        for (const warning of this.findDuplicatedSegments(translatedEntries)) {
            console.warn(chalk.yellow(`[duplicate] ${warning}`));
        }

        for (const warning of this.findGlossaryInconsistencies(entries, translatedEntries)) {
            console.warn(chalk.yellow(`[glossary] ${warning}`));
        }

        for (const warning of this.findPunctuationWidthInconsistencies(entries, translatedEntries)) {
            console.warn(chalk.yellow(`[punctuation] ${warning}`));
        }

        const neverTranslateWarnings = this.validateNeverTranslatePlaceholders(
            translatedEntries,
            neverTranslateReplacements
        );

        if (neverTranslateWarnings.length > 0) {
            for (const warning of neverTranslateWarnings) {
                console.warn(chalk.yellow(`[never-translate] ${warning}`));
            }

            const corruptedIds = new Set(
                neverTranslateWarnings.map(w => parseInt(w.match(/entry id (\d+)/)?.[1], 10)).filter(Boolean)
            );
            const corruptedEntries = translatedEntries.filter(e => corruptedIds.has(e.id));

            if (corruptedEntries.length > 0) {
                console.log(chalk.yellow(`[never-translate] retrying ${corruptedEntries.length} entr${corruptedEntries.length === 1 ? 'y' : 'ies'} with corrupted placeholders`));
                const validPlaceholders = neverTranslateReplacements.map(r => r.placeholder).join(', ');
                const { system } = this.createAstTranslationPrompt([], targetLanguage, sourceLanguage);
                const retryUserPrompt =
                    `Translate each item's text from ${sourceLanguage} to ${targetLanguage}.\n\n` +
                    'CRITICAL: The following tokens are protected placeholders that must be copied exactly as-is into your output:\n' +
                    `${validPlaceholders}\n\n` +
                    'Do not alter, simplify, renumber, or substitute these tokens in any way.\n\n' +
                    'Response format: Return ONLY a JSON array. Keep each id exactly as-is. Do not add or remove items. Do not include explanations or markdown code fences.\n\n' +
                    `Input JSON:\n${JSON.stringify(corruptedEntries)}`;

                const retryResponse = await this.callModel(retryUserPrompt, system);
                const retryText = this.getResponseText(retryResponse);

                try {
                    const retryTranslatedItems = this.parseJsonArrayFromModelText(retryText);
                    const retryMerged = this.mergeAstTranslationItems(corruptedEntries, retryTranslatedItems);
                    const retryWarnings = this.validateNeverTranslatePlaceholders(retryMerged.merged, neverTranslateReplacements);

                    if (retryWarnings.length < neverTranslateWarnings.length) {
                        const retryById = new Map(retryMerged.merged.map(e => [e.id, e.text]));
                        for (let i = 0; i < translatedEntries.length; i++) {
                            if (retryById.has(translatedEntries[i].id)) {
                                translatedEntries[i] = { ...translatedEntries[i], text: retryById.get(translatedEntries[i].id) };
                            }
                        }
                        const resolved = neverTranslateWarnings.length - retryWarnings.length;
                        console.log(chalk.green(`[never-translate] retry resolved ${resolved}/${neverTranslateWarnings.length} corrupted placeholder${resolved === 1 ? '' : 's'}`));
                        for (const w of retryWarnings) {
                            console.warn(chalk.yellow(`[never-translate] still corrupted after retry: ${w}`));
                        }
                    } else {
                        console.warn(chalk.yellow('[never-translate] retry did not improve placeholder fidelity, keeping original'));
                    }
                } catch {
                    console.warn(chalk.yellow('[never-translate] retry response could not be parsed, keeping original'));
                }
            }
        }

        const restoredNeverTranslateEntries = this.restoreNeverTranslateEntries(
            translatedEntries,
            neverTranslateReplacements
        );

        let translatedContent = this.restoreTranslatedContent(skeleton, restoredNeverTranslateEntries);

        const droppedPlaceholders = this.findDroppedInlinePlaceholders(translatedContent, inlinePlaceholders);
        if (droppedPlaceholders.length > 0) {
            console.warn(chalk.red(
                `[inline-placeholder] ❌ model dropped ${droppedPlaceholders.length} protected fragment` +
                `${droppedPlaceholders.length === 1 ? '' : 's'} — ` +
                `output is missing the source content they stood for: ${droppedPlaceholders.join(', ')}`
            ));
        }

        translatedContent = this.restoreInlinePlaceholders(translatedContent, inlinePlaceholders);
        translatedContent = this.fixJsxBlockIndentation(translatedContent);
        translatedContent = this.fixAdmonitionIndentation(translatedContent);
        translatedContent = this.fixHtmlTableNewlines(translatedContent);
        translatedContent = this.fixFrontmatterYamlQuoting(translatedContent);
        if (this.isEnglishTarget(targetLanguage)) {
            return this.normalizeEnglishInlineCodeSpacing(translatedContent);
        }

        return translatedContent.endsWith('\n') ? translatedContent : `${translatedContent}\n`;
    }

    async translateFileAstMvp(
        inputPath,
        outputPath,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false,
        trace = false
    ) {
        let translated = null;

        if (!await fs.pathExists(inputPath)) {
            throw new Error(`Input file does not exist: ${inputPath}`);
        }

        const content = await fs.readFile(inputPath, 'utf8');
        if (!content.trim()) {
            throw new Error('Input file is empty');
        }

        try {
            translated = await this.translateMarkdownAstMvp(
                content,
                targetLanguage,
                sourceLanguage,
                progressCallback,
                logChunkMetadata,
                trace
            );

            const { commentlessContent: originalNoComments } = this.stripHtmlComments(content);
            const { commentlessContent: translatedNoComments } = this.stripHtmlComments(translated);
            const originalStats = this.getMarkdownStats(originalNoComments);
            const translatedStats = this.getMarkdownStats(translatedNoComments);
            const finalMismatches = this.getCompletenessMismatches(originalNoComments, translatedNoComments);

            const finalStatus = finalMismatches.length === 0 ? 'PASS' : 'FAIL';
            const finalMessage =
                `[final check] Status=${finalStatus} ` +
                `(Original headings:${originalStats.headings}, code blocks:${originalStats.codeBlocks}, unordered list items:${originalStats.unorderedListItems}; ` +
                `Translated headings:${translatedStats.headings}, code blocks:${translatedStats.codeBlocks}, unordered list items:${translatedStats.unorderedListItems})` +
                `${finalMismatches.length > 0 ? ` (mismatches: ${finalMismatches.join('; ')})` : ''}`;
            console.log(finalMismatches.length === 0 ? chalk.green(finalMessage) : chalk.red(finalMessage));

            if (finalMismatches.length > 0) {
                throw new Error(`Final translation completeness check failed: ${finalMismatches.join('; ')}`);
            }

            const structuralFailures = this.findStructuralFailures(content, translated);
            if (structuralFailures.length > 0) {
                for (const failure of structuralFailures) {
                    console.error(chalk.red(`[structure] ${failure}`));
                }
                throw new Error(`Structural validation failed for ${outputPath}: ${structuralFailures.join('; ')}`);
            }

            await fs.ensureDir(path.dirname(outputPath));
            await fs.writeFile(outputPath, translated, 'utf8');

            return {
                inputPath,
                outputPath,
                sourceLanguage,
                targetLanguage,
                originalLength: content.length,
                translatedLength: translated.length
            };
        } catch (error) {
            if (translated) {
                const invalidPath = outputPath.endsWith('.md') || outputPath.endsWith('.markdown') || outputPath.endsWith('.mdx') ?
                    outputPath.replace(/\.(md|markdown|mdx)$/, '.invalid') :
                    `${outputPath}.invalid`;

                await fs.ensureDir(path.dirname(invalidPath));
                await fs.writeFile(invalidPath, translated, 'utf8');
                console.error(chalk.red(`❌ Translation failed - incomplete output written to: ${invalidPath}`));
            }

            throw error;
        }
    }

    async translateFile(
        inputPath,
        outputPath,
        targetLanguage,
        sourceLanguage = 'English',
        progressCallback,
        logChunkMetadata = false,
        trace = false
    ) {
        return await this.translateFileAstMvp(
            inputPath,
            outputPath,
            targetLanguage,
            sourceLanguage,
            progressCallback,
            logChunkMetadata,
            trace
        );
    }
}

export default AstMarkdownTranslator;
