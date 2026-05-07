import path from 'path';

import chalk from 'chalk';
import fs from 'fs-extra';
import remarkFrontmatter from 'remark-frontmatter';
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

    createAstParser() {
        return unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkMdx);
    }

    createAstStringifier() {
        return unified()
        .use(remarkFrontmatter, ['yaml'])
        .use(remarkStringify, { fences: true, bullet: '-', listItemIndent: 'one' })
        .use(remarkMdx);
    }

    buildPlaceholder(id) {
        return `__MTX_${id}__`;
    }

    buildInlineCodePlaceholder(id) {
        return `__MTX_CODE_${id}__`;
    }

    buildNeverTranslatePlaceholder(id) {
        return `__MTX_NEVER_${id}__`;
    }

    isFullyProtected(text) {
        return typeof text === 'string' && /^(\s*__MTX_NEVER_\d+__\s*)+$/.test(text);
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

        for (const term of sortedTerms) {
            if (!term) {
                continue;
            }

            const escapedTerm = this.escapeForRegex(term);
            const pattern = new RegExp(escapedTerm, 'g');

            output = output.replace(pattern, () => {
                const placeholder = this.buildNeverTranslatePlaceholder(replacements.length + 1);
                replacements.push({ placeholder, value: term });
                return placeholder;
            });
        }

        return output;
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

    extractTranslatableContent(content) {
        const parser = this.createAstParser();
        const stringifier = this.createAstStringifier();
        const tree = parser.parse(content);

        const entries = [];
        const inlineCodePlaceholders = [];
        let nextId = 1;
        let nextInlineCodeId = 1;

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
                const isTranslatableRunNode = child?.type === 'text' || child?.type === 'inlineCode';

                if (!isTranslatableRunNode) {
                    rebuiltChildren.push(child);
                    index += 1;
                    continue;
                }

                const run = [];
                let hasTranslatableText = false;

                while (index < children.length) {
                    const runChild = children[index];
                    const isRunNode = runChild?.type === 'text' || runChild?.type === 'inlineCode';
                    if (!isRunNode) {
                        break;
                    }

                    if (runChild.type === 'text' && this.shouldTranslateValue(runChild.value)) {
                        hasTranslatableText = true;
                    }

                    run.push(runChild);
                    index += 1;
                }

                if (!hasTranslatableText) {
                    rebuiltChildren.push(...run);
                    continue;
                }

                let combinedText = '';
                for (const runChild of run) {
                    if (runChild.type === 'text') {
                        combinedText += runChild.value || '';
                    } else {
                        const inlineCodePlaceholder = this.buildInlineCodePlaceholder(nextInlineCodeId);
                        inlineCodePlaceholders.push({
                            placeholder: inlineCodePlaceholder,
                            value: runChild.value || ''
                        });
                        combinedText += `\`${inlineCodePlaceholder}\``;
                        nextInlineCodeId += 1;
                    }
                }

                registerEntry(combinedText, (entryPlaceholder) => {
                    rebuiltChildren.push({ type: 'text', value: entryPlaceholder });
                });
            }

            node.children = rebuiltChildren;

            for (const child of node.children) {
                processChildrenForInlineCodeContext(child);
            }
        };

        processChildrenForInlineCodeContext(tree);

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
            inlineCodePlaceholders
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

        const taskPrompt =
            `Translate each item's text from ${sourceLanguage} to ${targetLanguage}.\n\n` +
            'Response format requirements:\n' +
            '1) Return ONLY a JSON array.\n' +
            '2) Keep each id exactly as-is.\n' +
            '3) Translate only text values.\n' +
            '4) Do not add or remove items.\n' +
            '5) Do not include explanations or markdown code fences.\n' +
            '6) Tokens matching __MTX_CODE_<number>__ are protected placeholders for inline code. Keep them exactly unchanged. Do not translate, split, remove, or rename them.\n' +
            '7) Tokens matching __MTX_NEVER_<number>__ are protected placeholders for never-translate terms. Keep them exactly unchanged. Do not translate, split, remove, or rename them.\n\n' +
            `Input JSON:\n${payload}`;

        if (systemPrompt) {
            return `${systemPrompt}\n\n### TASK ###\n${taskPrompt}`;
        }

        return taskPrompt;
    }

    createAstTranslationRepairPrompt(items, targetLanguage, sourceLanguage, parseErrorMessage) {
        const basePrompt = this.createAstTranslationPrompt(items, targetLanguage, sourceLanguage);
        return `${basePrompt}\n\nYour previous response could not be parsed as JSON (${parseErrorMessage}). Return STRICT valid JSON only.`;
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
        const prompt = this.createAstTranslationPrompt(items, targetLanguage, sourceLanguage);
        const result = await this.model.generateContent(prompt);
        const response = await result.response;
        const metadata = this.extractChunkMetadata(response);

        try {
            return {
                translatedItems: this.parseJsonArrayFromModelText(response.text()),
                metadata,
                repairMetadata: null,
                parseWarnings: []
            };
        } catch (initialParseError) {
            const repairPrompt = this.createAstTranslationRepairPrompt(
                items,
                targetLanguage,
                sourceLanguage,
                initialParseError.message
            );
            const repairResult = await this.model.generateContent(repairPrompt);
            const repairResponse = await repairResult.response;
            const repairMetadata = this.extractChunkMetadata(repairResponse);

            try {
                return {
                    translatedItems: this.parseJsonArrayFromModelText(repairResponse.text()),
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
        let output = skeleton;

        for (const entry of translatedEntries) {
            const placeholder = this.buildPlaceholder(entry.id);
            const escapedPlaceholder = placeholder.replaceAll('_', '\\_');
            output = output.split(placeholder).join(entry.text);
            output = output.split(escapedPlaceholder).join(entry.text);
        }

        return output;
    }

    restoreInlineCodePlaceholders(content, inlineCodePlaceholders) {
        let output = content;

        for (const item of inlineCodePlaceholders) {
            const escapedPlaceholder = item.placeholder.replaceAll('_', '\\_');
            const inlineCodeValue = item.value || '';
            output = output.split(item.placeholder).join(inlineCodeValue);
            output = output.split(escapedPlaceholder).join(inlineCodeValue);
        }

        return output;
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

    normalizeEnglishInlineCodeSpacing(content) {
        const parser = this.createAstParser();
        const stringifier = this.createAstStringifier();
        const tree = parser.parse(content);

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

        const normalized = stringifier.stringify(tree);
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
        const { skeleton, entries, inlineCodePlaceholders } = this.extractTranslatableContent(content);
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

        const restoredNeverTranslateEntries = this.restoreNeverTranslateEntries(
            translatedEntries,
            neverTranslateReplacements
        );

        let translatedContent = this.restoreTranslatedContent(skeleton, restoredNeverTranslateEntries);
        translatedContent = this.restoreInlineCodePlaceholders(translatedContent, inlineCodePlaceholders);
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
