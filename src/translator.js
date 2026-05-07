import path from 'path';

import { GoogleGenerativeAI } from '@google/generative-ai';
import chalk from 'chalk';
import fs from 'fs-extra';
import { glob } from 'glob';

class MarkdownTranslator {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('Google Gemini API key is required');
        }

        this.apiKey = apiKey;

        this.genAI = new GoogleGenerativeAI(apiKey);
        this.neverTranslateTerms = [];
        this.modelName = 'gemini-2.5-flash';
        this.model = this.genAI.getGenerativeModel({
            model: this.modelName,
            generationConfig: {
                temperature: 0
            }
        });

        console.log(chalk.gray(`Using model: ${this.modelName} (temperature: 0)`));

        try {
            const configsDir = path.join(process.cwd(), 'src', 'configs');
            const systemPromptPath = path.join(configsDir, 'system_prompt.txt');
            if (fs.existsSync(systemPromptPath)) {
                this.systemPromptTemplate = fs.readFileSync(systemPromptPath, 'utf8');
            }

            const dictDir = path.join(configsDir, 'language_dicts');
            this.languageDictionaries = {};
            if (fs.existsSync(dictDir)) {
                const files = fs.readdirSync(dictDir);
                for (const fileName of files) {
                    const fullPath = path.join(dictDir, fileName);
                    if (fs.statSync(fullPath).isFile() && (fileName.endsWith('.yml') || fileName.endsWith('.yaml'))) {
                        const key = fileName.replace(/\.ya?ml$/i, '').toLowerCase();
                        this.languageDictionaries[key] = fs.readFileSync(fullPath, 'utf8');
                    }
                }
            }

            const neverPath = path.join(configsDir, 'never_translate.yaml');
            if (fs.existsSync(neverPath)) {
                this.neverTranslate = fs.readFileSync(neverPath, 'utf8');
                this.neverTranslateTerms = this.parseYamlList(this.neverTranslate);
            } else {
                const neverPathYml = path.join(configsDir, 'never_translate.yml');
                if (fs.existsSync(neverPathYml)) {
                    this.neverTranslate = fs.readFileSync(neverPathYml, 'utf8');
                    this.neverTranslateTerms = this.parseYamlList(this.neverTranslate);
                }
            }
        } catch {
            this.systemPromptTemplate = this.systemPromptTemplate || null;
            this.languageDictionaries = this.languageDictionaries || {};
        }
    }

    parseYamlList(rawText) {
        if (typeof rawText !== 'string' || !rawText.trim()) {
            return [];
        }

        const terms = [];
        const seen = new Set();
        const lines = rawText.split(/\r?\n/);

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            if (!trimmed.startsWith('-')) {
                continue;
            }

            let term = trimmed.slice(1).trim();
            if (!term) {
                continue;
            }

            if (
                (term.startsWith('"') && term.endsWith('"')) ||
                (term.startsWith('\'') && term.endsWith('\''))
            ) {
                term = term.slice(1, -1).trim();
            }

            if (!term || seen.has(term)) {
                continue;
            }

            seen.add(term);
            terms.push(term);
        }

        return terms;
    }

    normalizeLanguageKey(language) {
        if (!language) {
            return '';
        }

        const normalized = language.toString().trim().toLowerCase();
        const map = {
            en: 'en',
            english: 'en',
            ja: 'ja',
            japanese: 'ja',
            jp: 'ja',
            zh: 'zh',
            chinese: 'zh',
            'simplified chinese': 'zh',
            'traditional chinese': 'zh'
        };

        if (map[normalized]) {
            return map[normalized];
        }

        return normalized.replace(/[^a-z]/g, '');
    }

    getDictionaryForLanguage(targetLanguage) {
        const key = this.normalizeLanguageKey(targetLanguage);
        if (!key || !this.languageDictionaries || typeof this.languageDictionaries !== 'object') {
            return '';
        }

        return this.languageDictionaries[key] || '';
    }

    renderSystemPrompt(sourceLanguage, targetLanguage) {
        const dictionary = this.getDictionaryForLanguage(targetLanguage);
        const neverTranslate = this.neverTranslate || '';
        const dollar = '$';
        const sourcePlaceholder = `${dollar}{source_lang}`;
        const targetPlaceholder = `${dollar}{target_lang}`;
        const dictionaryPlaceholder = `${dollar}{dictionary}`;
        const neverPlaceholder = `${dollar}{never_translate}`;

        if (!this.systemPromptTemplate || typeof this.systemPromptTemplate !== 'string') {
            return '';
        }

        let rendered = this.systemPromptTemplate;
        rendered = rendered.replaceAll(sourcePlaceholder, String(sourceLanguage || 'English'));
        rendered = rendered.replaceAll(targetPlaceholder, String(targetLanguage || ''));
        rendered = rendered.replaceAll(dictionaryPlaceholder, dictionary);
        rendered = rendered.replaceAll(neverPlaceholder, neverTranslate);
        return rendered.trim();
    }

    getMarkdownStats(content) {
        const lines = content.split('\n');
        let inCodeBlock = false;
        let fenceChar = null;
        let fenceLen = 0;
        let headings = 0;
        let codeBlocks = 0;
        let unorderedListItems = 0;

        for (const line of lines) {
            const fenceMatch = line.match(/^\s*([`~]{3,})/);
            if (fenceMatch) {
                const currentFence = fenceMatch[1];
                const currentChar = currentFence[0];
                const currentLen = currentFence.length;

                if (!inCodeBlock) {
                    inCodeBlock = true;
                    fenceChar = currentChar;
                    fenceLen = currentLen;
                    codeBlocks += 1;
                } else if (currentChar === fenceChar && currentLen >= fenceLen) {
                    inCodeBlock = false;
                    fenceChar = null;
                    fenceLen = 0;
                }

                continue;
            }

            if (!inCodeBlock && /^\s{0,3}#{1,6}\s+\S/.test(line)) {
                headings += 1;
            }

            if (!inCodeBlock && /^\s*[-*]\s+\S/.test(line)) {
                unorderedListItems += 1;
            }
        }

        return { headings, codeBlocks, unorderedListItems };
    }

    getCompletenessMismatches(originalContent, translatedContent) {
        const originalStats = this.getMarkdownStats(originalContent);
        const translatedStats = this.getMarkdownStats(translatedContent);

        const mismatches = [];
        if (originalStats.headings !== translatedStats.headings) {
            mismatches.push(`headings (expected ${originalStats.headings}, got ${translatedStats.headings})`);
        }
        if (originalStats.codeBlocks !== translatedStats.codeBlocks) {
            mismatches.push(`code blocks (expected ${originalStats.codeBlocks}, got ${translatedStats.codeBlocks})`);
        }
        if (originalStats.unorderedListItems !== translatedStats.unorderedListItems) {
            mismatches.push(
                `unordered list items (expected ${originalStats.unorderedListItems}, got ${translatedStats.unorderedListItems})`
            );
        }

        return mismatches;
    }

    stripHtmlComments(content) {
        const commentsMap = [];
        let placeholder = 0;
        const commentlessContent = content.replace(
            /<!--(?:(?!<!--)[\s\S])*?-->/g,
            (match) => {
                commentsMap.push(match);
                return `__HTML_COMMENT_${placeholder++}__`;
            }
        );
        return { commentlessContent, commentsMap };
    }

    restoreHtmlComments(content, commentsMap) {
        let result = content;
        commentsMap.forEach((comment, index) => {
            result = result.replace(`__HTML_COMMENT_${index}__`, comment);
        });
        return result;
    }

    extractChunkMetadata(response) {
        const candidate = response?.candidates?.[0];
        return {
            finishReason: candidate?.finishReason || null,
            safetyRatings: candidate?.safetyRatings || null,
            promptFeedback: response?.promptFeedback || null,
            usageMetadata: response?.usageMetadata || null,
            candidates: response?.candidates?.length ?? null
        };
    }

    translateFile() {
        throw new Error('translateFile must be implemented by the AST translator');
    }

    async translateFiles(inputPattern, outputDir, targetLanguage, options = {}) {
        const {
            progressCallback,
            preserveStructure = true,
            suffix = '',
            source = 'English',
            logChunkMetadata = false,
            trace = false
        } = options;

        try {
            const normalizedPattern = inputPattern.replace(/\\/g, '/');
            console.log(chalk.blue(`Finding files matching pattern: ${inputPattern}`));

            const files = await glob(normalizedPattern, {
                ignore: ['node_modules/**', '.git/**', '**/.*'],
                windowsPathsNoEscape: true
            });

            if (files.length === 0) {
                throw new Error(`No files found matching pattern: ${inputPattern}`);
            }

            const markdownFiles = files.filter((filePath) => {
                const ext = path.extname(filePath).toLowerCase();
                return ext === '.md' || ext === '.markdown' || ext === '.mdx';
            });

            if (markdownFiles.length === 0) {
                throw new Error('No markdown files found in the matched files');
            }

            console.log(chalk.green(`Found ${markdownFiles.length} markdown file(s) to translate`));
            await fs.ensureDir(outputDir);

            const results = [];
            let processedFiles = 0;

            for (const inputFile of markdownFiles) {
                try {
                    let outputPath;
                    if (preserveStructure) {
                        const normalizedInputFile = inputFile.replace(/\\/g, '/');
                        const normalizedInputPattern = inputPattern.replace(/\\/g, '/');

                        let baseDir = '';
                        if (path.isAbsolute(normalizedInputPattern)) {
                            const patternParts = normalizedInputPattern.split('/');
                            const wildcardIndex = patternParts.findIndex(part => part.includes('*'));
                            if (wildcardIndex > 0) {
                                baseDir = patternParts.slice(0, wildcardIndex).join('/');
                            }
                        }

                        let relativePath;
                        if (baseDir && normalizedInputFile.startsWith(baseDir)) {
                            relativePath = path.relative(baseDir, normalizedInputFile);
                        } else {
                            relativePath = path.relative(process.cwd(), normalizedInputFile);
                        }

                        const parsed = path.parse(relativePath);
                        const newName = suffix ? `${parsed.name}_${suffix}${parsed.ext}` : `${parsed.name}${parsed.ext}`;
                        outputPath = path.join(outputDir, parsed.dir, newName);
                    } else {
                        const parsed = path.parse(inputFile);
                        const newName = suffix ? `${parsed.name}_${suffix}${parsed.ext}` : `${parsed.name}${parsed.ext}`;
                        outputPath = path.join(outputDir, newName);
                    }

                    console.log(chalk.yellow(`\n[${processedFiles + 1}/${markdownFiles.length}] Translating: ${inputFile}`));

                    const currentFileIndex = processedFiles + 1;
                    const fileProgressCallback = progressCallback ?
                        (chunk, total) => progressCallback(currentFileIndex, markdownFiles.length, chunk, total, inputFile) :
                        undefined;

                    // eslint-disable-next-line no-await-in-loop
                    const result = await this.translateFile(
                        inputFile,
                        outputPath,
                        targetLanguage,
                        source,
                        fileProgressCallback,
                        logChunkMetadata,
                        trace
                    );
                    results.push(result);

                    processedFiles += 1;
                    console.log(chalk.green(`✅ Completed: ${outputPath}`));
                } catch (error) {
                    console.error(chalk.red(`❌ Failed to translate ${inputFile}: ${error.message}`));
                    results.push({
                        inputPath: inputFile,
                        error: error.message,
                        success: false
                    });
                }
            }

            const successful = results.filter(result => !result.error).length;
            const failed = results.length - successful;

            console.log(chalk.blue('\n📊 Batch Translation Summary:'));
            console.log(chalk.green(`   ✅ Successful: ${successful}`));
            if (failed > 0) {
                console.log(chalk.red(`   ❌ Failed: ${failed}`));
            }
            console.log(chalk.gray(`   📁 Output directory: ${outputDir}`));

            return results;
        } catch (error) {
            console.error(chalk.red(`Error in batch translation: ${error.message}`));
            throw error;
        }
    }

    static getSupportedLanguages() {
        return [
            'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch',
            'Russian', 'Chinese', 'Japanese', 'Korean', 'Arabic', 'Hindi',
            'Turkish', 'Polish', 'Swedish', 'Norwegian', 'Danish', 'Finnish',
            'Greek', 'Hebrew', 'Thai', 'Vietnamese', 'Indonesian', 'Malay',
            'Ukrainian', 'Czech', 'Hungarian', 'Romanian', 'Bulgarian',
            'Croatian', 'Serbian', 'Slovak', 'Slovenian', 'Estonian',
            'Latvian', 'Lithuanian', 'Catalan', 'Basque', 'Welsh', 'Irish'
        ];
    }
}

export default MarkdownTranslator;
