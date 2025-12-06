require('dotenv').config();

const sanityClient = require('@sanity/client');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // ID生成用

// ==============================
// Config loading
// ==============================
let config;
try {
    const customConfigPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(customConfigPath)) {
        config = JSON.parse(fs.readFileSync(customConfigPath, 'utf8'));
        console.log('✓ Using custom configuration (config.json)\n');
    } else {
        config = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'),
        );
        console.log('✓ Using default configuration (config.default.json)\n');
    }
} catch (error) {
    console.error('❌ Failed to load configuration:', error.message);
    process.exit(1);
}

// ==============================
// Sanity client configuration
// ==============================
const client = sanityClient.default({
    projectId: process.env.SANITY_PROJECT_ID,
    dataset: process.env.SANITY_DATASET,
    token: process.env.SANITY_TOKEN,
    apiVersion: '2024-01-01',
    useCdn: false,
});

// Environment debug output
console.log('=== Environment Check ===');
console.log('Project ID:', process.env.SANITY_PROJECT_ID);
console.log('Dataset:', process.env.SANITY_DATASET);
console.log('Token prefix:', process.env.SANITY_TOKEN?.substring(0, 4));
console.log('Token length:', process.env.SANITY_TOKEN?.length);
console.log('Craft Token prefix:', process.env.CRAFT_TOKEN?.substring(0, 4));
console.log('========================\n');

const CRAFT_API_URL = process.env.CRAFT_API_URL;

// ==============================
// Levenshtein & fuzzy matching
// ==============================
function levenshteinDistance(str1, str2) {
    const s = (str1 || '').toLowerCase();
    const t = (str2 || '').toLowerCase();
    if (!s.length) return t.length;
    if (!t.length) return s.length;

    const arr = [];
    for (let i = 0; i <= t.length; i++) {
        arr[i] = [i];
        for (let j = 1; j <= s.length; j++) {
            arr[i][j] =
                i === 0
                    ? j
                    : Math.min(
                        arr[i - 1][j] + 1,
                        arr[i][j - 1] + 1,
                        arr[i - 1][j - 1] + (s[j - 1] === t[i - 1] ? 0 : 1),
                    );
        }
    }
    return arr[t.length][s.length];
}

function findSimilarName(input, existingItems, threshold = 2) {
    let bestMatch = null;
    let bestDistance = Infinity;

    for (const item of existingItems) {
        const base = item.name || item.title;

        if (!base || typeof base !== 'string') {
            continue;
        }

        const distance = levenshteinDistance(input, base);
        if (distance < bestDistance && distance <= threshold) {
            bestDistance = distance;
            bestMatch = item;
        }
    }

    return bestMatch ? { match: bestMatch, distance: bestDistance } : null;
}

// ==============================
// Image upload helper
// ==============================
async function uploadImageFromUrl(imageUrl, filename = 'image.jpg') {
    try {
        console.log(`    Downloading image from: ${imageUrl}`);
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
        }
        const buffer = await response.buffer();
        console.log(`    Uploading to Sanity... (${buffer.length} bytes)`);

        const imageAsset = await client.assets.upload('image', buffer, {
            filename: filename,
            contentType: response.headers.get('content-type') || 'image/jpeg',
        });

        console.log(`    ✓ Image uploaded: ${imageAsset._id}`);
        return imageAsset._id;
    } catch (error) {
        console.error(`    ✗ Image upload failed:`, error.message);
        return null;
    }
}

// ==============================
// CLI entrypoint
// ==============================
async function main() {
    const args = process.argv.slice(2);
    const isDraft = args.includes('--draft');
    const searchQuery = args.find((arg) => !arg.startsWith('--'));

    if (!searchQuery) {
        console.error('Error: Document title is required');
        console.log('Usage: node publish-to-sanity.js "Document Title" [--draft]');
        console.log('');
        console.log('Examples:');
        console.log('  npm run publish -- "My Article"    (publish to production)');
        console.log('  npm run bridge -- "My Article"     (save as draft)');
        process.exit(1);
    }

    if (isDraft) {
        console.log('📝 Draft mode - saving to drafts.<id> (will not be public)\n');
    } else {
        console.log('✅ Publish mode - saving directly to published document\n');
    }

    console.log('Starting publication process...\n');

    try {
        // 1. Fetch document list from Craft
        console.log('[1/6] Fetching document list...');
        const documents = await fetchDocumentList();

        const targetDoc = documents.find(
            (doc) =>
                doc.title &&
                doc.title.toLowerCase().includes(searchQuery.toLowerCase()),
        );

        if (!targetDoc) {
            console.log('\nAvailable documents:');
            documents.forEach((doc, i) => {
                console.log(`  ${i}: ${doc.title || 'Untitled'}`);
            });
            throw new Error(
                `Document with title containing "${searchQuery}" not found`,
            );
        }

        const documentId = targetDoc.id;
        console.log(
            `  Target document: ${targetDoc.title} (ID: ${documentId})\n`,
        );

        // 2. Fetch document blocks from Craft
        console.log('[2/6] Fetching document blocks...');
        const craftBlocks = await fetchCraftBlocks(documentId);
        const pageBlock = craftBlocks[0];
        console.log(
            `  Document fetched: ${pageBlock.markdown.substring(0, 50)}...\n`,
        );

        // 3. Extract metadata from Craft blocks
        console.log('[3/6] Extracting metadata...');
        const metadata = extractMetadata(pageBlock);
        console.log('  Metadata:', metadata);
        console.log('');

        // 4. Resolve or create author and categories
        console.log('[4/6] Processing author and category...');
        const authorRef = await getAuthorByName(metadata.author);
        const categoryRefs = await getCategoriesByTitle(metadata.category);
        console.log('  Author:', authorRef);
        console.log('  Categories:', categoryRefs);
        console.log('');

        // 5. Convert Craft content to Portable Text and upload images
        console.log('[5/6] Converting content...');
        const mainImageUrl = extractMainImage(pageBlock.content);

        let mainImageRef = null;
        if (mainImageUrl) {
            console.log('  Uploading main image...');
            const mainImageAssetId = await uploadImageFromUrl(
                mainImageUrl,
                'main-image.jpg',
            );
            if (mainImageAssetId) {
                mainImageRef = {
                    _type: 'image',
                    asset: {
                        _type: 'reference',
                        _ref: mainImageAssetId,
                    },
                };
            }
        }

        const body = await convertToPortableText(pageBlock.content);
        console.log(`  Content converted: ${body.length} blocks\n`);

        // 6. Create or update post in Sanity
        console.log('[6/6] Creating or updating post in Sanity...');
        const post = await createOrUpdateSanityPost(
            {
                title: metadata.title,
                slug: metadata.slug,
                publishedAt: metadata.publishedAt,
                author: authorRef,
                categories: categoryRefs,
                body: body,
                mainImage: mainImageRef,
                excerpt: metadata.excerpt,
                featured: metadata.featured,
                tags: metadata.tags,
                seoTitle: metadata.seoTitle,
                seoDescription: metadata.seoDescription,
            },
            isDraft,
        );

        console.log('\n✓ Success!');
        console.log('  ID:', post._id);
        console.log('  Title:', post.title);
        console.log('  Slug:', post.slug.current);

        if (post._id.startsWith('drafts.')) {
            console.log('  🟡 Saved as Draft (ID starts with drafts.)');
        } else {
            console.log('  🟢 Published (ID does not have drafts. prefix)');
        }

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error);
        process.exit(1);
    }
}

// ==============================
// Craft API helpers
// ==============================
async function fetchDocumentList() {
    const url = `${CRAFT_API_URL}/documents`;
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${process.env.CRAFT_TOKEN}` // Token認証を追加
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch documents: ${response.statusText}`);
    }
    const data = await response.json();
    if (Array.isArray(data)) {
        return data;
    } else if (data.items && Array.isArray(data.items)) {
        return data.items;
    } else {
        throw new Error('Unexpected response format from Craft API');
    }
}

async function fetchCraftBlocks(documentId) {
    const url = `${CRAFT_API_URL}/blocks?id=${documentId}`;
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${process.env.CRAFT_TOKEN}` // Token認証を追加
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch document: ${response.statusText}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [data];
}

// ==============================
// Metadata extraction
// ==============================
function extractMetadata(pageBlock) {
    const markers = config.craft.metadata;
    const content = pageBlock.content;

    const metadata = {
        title: pageBlock.markdown || 'Untitled',
        slug: 'untitled',
        author: 'Unknown',
        category: ['Uncategorized'],
        publishedAt: new Date().toISOString(),
    };

    for (const block of content) {
        if (block.type === 'text' && block.markdown) {
            const text = block.markdown;

            for (const [key, marker] of Object.entries(markers)) {
                if (!text.startsWith(marker)) continue;

                let value = text.replace(marker, '').trim();
                let targetKey = key;

                if (key === 'category' || key === 'tags') {
                    value = value.split(',').map((c) => c.trim());
                } else if (key === 'publishedDate') {
                    const match = value.match(/(\d{4}-\d{2}-\d{2})/);
                    if (match) {
                        value = new Date(match[1]).toISOString();
                    }
                    targetKey = 'publishedAt';
                } else if (key === 'featured') {
                    value = value.toLowerCase() === 'true';
                }

                metadata[targetKey] = value;
            }
        }
    }

    return metadata;
}

// ==============================
// Main image extraction
// ==============================
function extractMainImage(blocks) {
    for (const block of blocks) {
        if (block.type === 'image' && block.url) {
            return block.url;
        }
    }
    return null;
}

// ==============================
// Author & Category resolution
// ==============================
async function getAuthorByName(name) {
    const authorConfig = config.sanity.author;
    const authorType = authorConfig.type;
    const nameField = authorConfig.fields.name;
    const slugField = authorConfig.fields.slug;

    console.log(`  Checking author: ${name}...`);

    const allAuthors = await client.fetch(
        `*[_type == $type]{ _id, ${nameField}, ${slugField} }`,
        { type: authorType },
    );
    console.log('  Available authors:', allAuthors);

    // Exact match
    const existing = await client.fetch(
        `*[_type == $type && ${nameField} == $name][0]`,
        { type: authorType, name },
    );

    if (existing) {
        console.log(
            `  ✓ Author found: ${existing[nameField]} (ID: ${existing._id})`,
        );
        return {
            _type: 'reference',
            _ref: existing._id,
        };
    }

    // Fuzzy match
    const similar = findSimilarName(
        name,
        allAuthors.map((a) => ({ name: a[nameField], ...a })),
    );
    if (similar) {
        console.log(
            `  ⚠ Possible typo detected! Did you mean "${similar.match.name}"? (distance: ${similar.distance})`,
        );
        console.log(`  → Using existing author: ${similar.match.name}`);
        return {
            _type: 'reference',
            _ref: similar.match._id,
        };
    }

    // Create new author
    console.log(`  → Author not found. Creating new author: ${name}`);
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    const newAuthor = await client.create({
        _type: authorType,
        [nameField]: name,
        [slugField]: {
            _type: 'slug',
            current: slug,
        },
    });

    console.log(
        `  ✓ New author created: ${newAuthor[nameField]} (ID: ${newAuthor._id})`,
    );
    return {
        _type: 'reference',
        _ref: newAuthor._id,
    };
}

async function getCategoriesByTitle(titles) {
    const categoryConfig = config.sanity.category;
    const categoryType = categoryConfig.type;
    const titleField = categoryConfig.fields.title;
    const slugField = categoryConfig.fields.slug;
    const descriptionField = categoryConfig.fields.description;

    const refs = [];
    console.log('  Available Categories:');

    const allCategories = await client.fetch(
        `*[_type == $type]{ _id, ${titleField}, ${slugField} }`,
        { type: categoryType },
    );
    console.log('  ', JSON.stringify(allCategories, null, 2));
    console.log('');

    for (const title of titles) {
        if (!title) continue;
        console.log(`  Checking category: ${title}...`);

        // Exact match
        const existing = await client.fetch(
            `*[_type == $type && ${titleField} == $title][0]`,
            { type: categoryType, title },
        );

        if (existing) {
            console.log(
                `  ✓ Category found: ${existing[titleField]} (ID: ${existing._id})`,
            );
            refs.push({
                _type: 'reference',
                _ref: existing._id,
                _key: `cat-${Math.random().toString(36).substr(2, 9)}`,
            });
            continue;
        }

        // Fuzzy match
        const similar = findSimilarName(
            title,
            allCategories.map((c) => ({ title: c[titleField], ...c })),
        );
        if (similar) {
            console.log(
                `  ⚠ Possible typo detected! Did you mean "${similar.match.title}"? (distance: ${similar.distance})`,
            );
            console.log(`  → Using existing category: ${similar.match.title}`);
            refs.push({
                _type: 'reference',
                _ref: similar.match._id,
                _key: `cat-${Math.random().toString(36).substr(2, 9)}`,
            });
            continue;
        }

        // Create new category
        console.log(`  → Category not found. Creating new category: ${title}`);
        const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        const newCategoryData = {
            _type: categoryType,
            [titleField]: title,
            [slugField]: {
                _type: 'slug',
                current: slug,
            },
        };

        if (descriptionField) {
            newCategoryData[descriptionField] = `Auto-created category for ${title}`;
        }

        const newCategory = await client.create(newCategoryData);

        console.log(
            `  ✓ New category created: ${newCategory[titleField]} (ID: ${newCategory._id})`,
        );
        refs.push({
            _type: 'reference',
            _ref: newCategory._id,
            _key: `cat-${Math.random().toString(36).substr(2, 9)}`,
        });
    }

    return refs;
}

// ==============================
// Craft → Portable Text
// ==============================
async function convertToPortableText(blocks) {
    const portableBlocks = [];
    let skipUntilLine = false;
    const markers = config.craft.metadata;

    for (const block of blocks) {
        if (block.markdown) {
            let isMetadata = false;
            for (const marker of Object.values(markers)) {
                if (block.markdown.startsWith(marker)) {
                    isMetadata = true;
                    break;
                }
            }
            if (isMetadata) {
                skipUntilLine = true;
                continue;
            }
        }

        if (block.type === 'line') {
            skipUntilLine = false;
            continue;
        }

        if (skipUntilLine) continue;
        if (block.type === 'text' && !block.markdown.trim()) continue;

        if (block.type === 'text') {
            const style =
                block.textStyle === 'h2'
                    ? 'h2'
                    : block.textStyle === 'h3'
                        ? 'h3'
                        : 'normal';

            let cleanText = block.markdown
                .replace(/^#{1,6}\s+/, '')
                .replace(/\*\*/g, '')
                .replace(/\*/g, '');

            portableBlocks.push({
                _type: 'block',
                _key: `block-${Math.random().toString(36).substr(2, 9)}`,
                style: style,
                children: [
                    {
                        _type: 'span',
                        text: cleanText,
                        marks: [],
                    },
                ],
            });
        } else if (block.type === 'image' && block.url) {
            console.log(`  Uploading inline image...`);
            const imageAssetId = await uploadImageFromUrl(
                block.url,
                `inline-${Date.now()}.jpg`,
            );
            if (imageAssetId) {
                portableBlocks.push({
                    _type: 'image',
                    _key: `image-${Math.random().toString(36).substr(2, 9)}`,
                    asset: {
                        _type: 'reference',
                        _ref: imageAssetId,
                    },
                });
            }
        }
    }

    return portableBlocks;
}

// ==============================
// Create / update Sanity post (Drafts aware)
// ==============================
async function createOrUpdateSanityPost(data, isDraft = false) {
    const postConfig = config.sanity.post;
    const postType = postConfig.type;
    const fields = postConfig.fields;

    // 1. まず「公開されているID」を探す (slugで検索)
    //    ※ draftドキュメントは検索しない
    const published = await client.fetch(
        `*[_type == $type && !(_id in path("drafts.**")) && ${fields.slug}.current == $slug][0]{ _id, ${fields.title} }`,
        { type: postType, slug: data.slug },
    );

    // 2. Sanity用データオブジェクトを作成
    const postData = { _type: postType };

    for (const [dataKey, sanityField] of Object.entries(fields)) {
        if (!sanityField || data[dataKey] === undefined || data[dataKey] === null) {
            continue;
        }

        if (sanityField.includes('.')) {
            const parts = sanityField.split('.');
            let current = postData;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!current[parts[i]]) {
                    current[parts[i]] = {};
                }
                current = current[parts[i]];
            }
            current[parts[parts.length - 1]] = data[dataKey];
        } else {
            if (dataKey === 'slug') {
                postData[sanityField] = {
                    _type: 'slug',
                    current: data[dataKey],
                };
            } else {
                postData[sanityField] = data[dataKey];
            }
        }
    }

    if (isDraft) {
        // =================================
        // DRAFT MODE: drafts.<id> に書き込む
        // =================================
        let draftId;
        if (published) {
            // 既に公開済み記事がある場合 → そのIDのdraftを作る (drafts.<publishedId>)
            draftId = `drafts.${published._id}`;
            console.log(`  → Existing published post found (ID: ${published._id})`);
            console.log(`  → Creating/Updating DRAFT version (ID: ${draftId})...`);
        } else {
            // まだ公開記事がない場合 → UUIDを生成して draft を作る
            const existingDraft = await client.fetch(
                `*[_type == $type && (_id in path("drafts.**")) && ${fields.slug}.current == $slug][0]{ _id }`,
                { type: postType, slug: data.slug },
            );

            if (existingDraft) {
                draftId = existingDraft._id;
                console.log(`  → Existing draft found (ID: ${draftId})...`);
            } else {
                // 新規ドラフト
                draftId = `drafts.${crypto.randomUUID()}`;
                console.log(`  → Creating NEW draft (ID: ${draftId})...`);
            }
        }

        // IDを指定して createOrReplace する (確実にそのIDで書き込むため)
        const draftDoc = { ...postData, _id: draftId };
        return await client.createOrReplace(draftDoc);

    } else {
        // =================================
        // PUBLISH MODE: 公開IDに書き込む
        // =================================
        if (published) {
            console.log(`  → Existing published post found: "${published[fields.title]}" (ID: ${published._id})`);
            console.log(`  → Updating published post...`);
            return await client.patch(published._id).set(postData).commit();
        } else {
            console.log(`  → Creating NEW published post...`);
            // publishedAt がない場合は現在時刻を入れる（お好みで）
            if (fields.publishedAt && !postData[fields.publishedAt]) {
                postData[fields.publishedAt] = new Date().toISOString();
            }
            return await client.create(postData);
        }
    }
}

main();
