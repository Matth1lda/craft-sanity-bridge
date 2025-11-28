require('dotenv').config();
const sanityClient = require('@sanity/client');
const fetch = require('node-fetch');

// Sanity client configuration
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
console.log('========================\n');

const CRAFT_API_URL = process.env.CRAFT_API_URL;

// Compute Levenshtein distance (for typo detection)
function levenshteinDistance(str1, str2) {
    const s = str1.toLowerCase();
    const t = str2.toLowerCase();

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

// Find the most similar existing name (for typo detection)
function findSimilarName(input, existingItems, threshold = 2) {
    let bestMatch = null;
    let bestDistance = Infinity;

    for (const item of existingItems) {
        const distance = levenshteinDistance(input, item.name || item.title);
        if (distance < bestDistance && distance <= threshold) {
            bestDistance = distance;
            bestMatch = item;
        }
    }

    return bestMatch ? { match: bestMatch, distance: bestDistance } : null;
}

// Download image from Craft and upload to Sanity
async function uploadImageFromUrl(imageUrl, filename = 'image.jpg') {
    try {
        console.log(`  Downloading image from: ${imageUrl}`);
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
        }

        const buffer = await response.buffer();

        console.log(`  Uploading to Sanity... (${buffer.length} bytes)`);
        const imageAsset = await client.assets.upload('image', buffer, {
            filename: filename,
            contentType: response.headers.get('content-type') || 'image/jpeg',
        });

        console.log(`  ✓ Image uploaded: ${imageAsset._id}`);
        return imageAsset._id;
    } catch (error) {
        console.error(`  ✗ Image upload failed:`, error.message);
        return null;
    }
}

// CLI entrypoint
async function main() {
    const searchQuery = process.argv[2];
    if (!searchQuery) {
        console.error('Error: Document title is required');
        console.log('Usage: node publish-to-sanity.js "Document Title"');
        process.exit(1);
    }

    console.log('Starting publication process...\n');

    try {
        // 1. Fetch document list from Craft
        console.log('[1/6] Fetching document list...');
        const documents = await fetchDocumentList();

        // Find document by (partial) title match
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
        const post = await createOrUpdateSanityPost({
            title: metadata.title,
            slug: metadata.slug,
            publishedAt: metadata.publishedAt,
            author: authorRef,
            categories: categoryRefs,
            body: body,
            mainImage: mainImageRef,
        });

        console.log('\n✓ Success!');
        console.log('  ID:', post._id);
        console.log('  Title:', post.title);
        console.log('  Slug:', post.slug.current);
        console.log('  Status:', post._rev ? 'Updated' : 'Created');
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error);
        process.exit(1);
    }
}

// Fetch document list from Craft API
async function fetchDocumentList() {
    const url = `${CRAFT_API_URL}/documents`;
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
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

// Fetch blocks for a single Craft document
async function fetchCraftBlocks(documentId) {
    const url = `${CRAFT_API_URL}/blocks?id=${documentId}`;
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch document: ${response.statusText}`);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [data];
}

// Extract metadata (title, slug, author, category, date) from the first Craft page block
function extractMetadata(pageBlock) {
    const content = pageBlock.content;
    let title = pageBlock.markdown || 'Untitled';
    let slug = 'untitled';
    let author = 'Unknown';
    let category = ['Uncategorized'];
    let publishedAt = new Date().toISOString();

    for (const block of content) {
        if (block.type === 'text' && block.markdown) {
            const text = block.markdown;
            if (text.startsWith('Slug:')) {
                slug = text.replace('Slug:', '').trim();
            } else if (text.startsWith('Author:')) {
                author = text.replace('Author:', '').trim();
            } else if (text.startsWith('Category:')) {
                category = text
                    .replace('Category:', '')
                    .trim()
                    .split(',')
                    .map((c) => c.trim());
            } else if (text.startsWith('Published Date:')) {
                const match = text.match(/(\d{4}-\d{2}-\d{2})/);
                if (match) {
                    publishedAt = new Date(match[1]).toISOString();
                }
            }
        }
    }

    return { title, slug, author, category, publishedAt };
}

// Get the first image URL in the Craft blocks (used as main image)
function extractMainImage(blocks) {
    for (const block of blocks) {
        if (block.type === 'image' && block.url) {
            return block.url;
        }
    }
    return null;
}

// Resolve author by name, with typo detection and auto-creation
async function getAuthorByName(name) {
    console.log(`  Checking author: ${name}...`);
    const allAuthors = await client.fetch(
        `*[_type == "author"]{ _id, name, slug }`,
    );
    console.log('  Available authors:', allAuthors);

    // Exact match
    const existing = await client.fetch(
        `*[_type == "author" && name == $name][0]`,
        { name },
    );

    if (existing) {
        console.log(`  ✓ Author found: ${existing.name} (ID: ${existing._id})`);
        return {
            _type: 'reference',
            _ref: existing._id,
        };
    }

    // Fuzzy match for typos
    const similar = findSimilarName(name, allAuthors);
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

    // Create new author if none found
    console.log(`  → Author not found. Creating new author: ${name}`);
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    const newAuthor = await client.create({
        _type: 'author',
        name: name,
        slug: {
            _type: 'slug',
            current: slug,
        },
    });

    console.log(
        `  ✓ New author created: ${newAuthor.name} (ID: ${newAuthor._id})`,
    );
    return {
        _type: 'reference',
        _ref: newAuthor._id,
    };
}

// Resolve categories by title, with typo detection and auto-creation
async function getCategoriesByTitle(titles) {
    const refs = [];

    console.log('  Available Categories:');
    const allCategories = await client.fetch(
        `*[_type == "category"]{ _id, title, slug }`,
    );
    console.log('  ', JSON.stringify(allCategories, null, 2));
    console.log('');

    for (const title of titles) {
        if (!title) continue;

        console.log(`  Checking category: ${title}...`);

        // Exact match
        const existing = await client.fetch(
            `*[_type == "category" && title == $title][0]`,
            { title },
        );

        if (existing) {
            console.log(
                `  ✓ Category found: ${existing.title} (ID: ${existing._id})`,
            );
            refs.push({
                _type: 'reference',
                _ref: existing._id,
                _key: `cat-${Math.random().toString(36).substr(2, 9)}`,
            });
            continue;
        }

        // Fuzzy match for typos
        const similar = findSimilarName(title, allCategories);
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

        // Create new category if none found
        console.log(`  → Category not found. Creating new category: ${title}`);
        const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        const newCategory = await client.create({
            _type: 'category',
            title: title,
            slug: {
                _type: 'slug',
                current: slug,
            },
            description: `Auto-created category for ${title}`,
        });

        console.log(
            `  ✓ New category created: ${newCategory.title} (ID: ${newCategory._id})`,
        );
        refs.push({
            _type: 'reference',
            _ref: newCategory._id,
            _key: `cat-${Math.random().toString(36).substr(2, 9)}`,
        });
    }

    return refs;
}

// Convert Craft blocks to Portable Text, uploading inline images to Sanity
async function convertToPortableText(blocks) {
    const portableBlocks = [];
    let skipUntilLine = false;

    for (const block of blocks) {
        // Skip metadata lines
        if (
            block.markdown &&
            (block.markdown.startsWith('Slug:') ||
                block.markdown.startsWith('Published Date:') ||
                block.markdown.startsWith('Author:') ||
                block.markdown.startsWith('Category:'))
        ) {
            skipUntilLine = true;
            continue;
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

            // Strip markdown markers (headings, bold, italics)
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

// Create a new post or update an existing one in Sanity (matched by slug)
async function createOrUpdateSanityPost(data) {
    const existing = await client.fetch(
        `*[_type == "post" && slug.current == $slug][0]{ _id, title }`,
        { slug: data.slug },
    );

    const postData = {
        _type: 'post',
        title: data.title,
        slug: {
            _type: 'slug',
            current: data.slug,
        },
        publishedAt: data.publishedAt,
        author: data.author,
        categories: data.categories,
        body: data.body,
    };

    if (data.mainImage) {
        postData.mainImage = data.mainImage;
    }

    if (existing) {
        console.log(
            `  → Existing post found: "${existing.title}" (ID: ${existing._id})`,
        );
        console.log(`  → Updating post...`);

        const updated = await client.patch(existing._id).set(postData).commit();
        return updated;
    } else {
        console.log(`  → Creating new post...`);
        return await client.create(postData);
    }
}

main();
