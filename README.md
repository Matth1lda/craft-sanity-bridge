# craft-sanity-bridge

A simple CLI tool to sync articles written in Craft Docs to Sanity CMS with a single command.  
It pushes your content, images, and metadata into a Sanity document in one go.

## Features

- Converts Craft Markdown blocks into Sanity Portable Text blocks.  
- Downloads images from Craft and uploads them to Sanity Assets, embedding them in the Portable Text body.  
- Reads metadata at the top of the document (e.g. `Slug:`, `Author:`, `Category:`) and maps values to Sanity fields.  
- Resolves Author / Category references by name and creates them if missing, with light typo correction using Levenshtein distance.  
- Supports Draft and Publish modes via separate commands (`npm run bridge` / `npm run publish`).  
- Customizable field mapping through `config.json`, including nested fields and different Sanity schemas.

## Requirements

- Node.js v16 or later is recommended.  
- Craft Docs with API sharing enabled (API endpoint + token).  
- A Sanity project with `projectId`, `dataset`, and an API token with write permissions.  

## Installation

```bash
git clone https://github.com/Matth1lda/craft-sanity-bridge.git
cd craft-sanity-bridge
npm install
```

## Configuration

### 1. Environment variables (.env)

Create a `.env` file in the project root and fill it using `.env.example` as a reference.

```env
# Sanity Settings
SANITY_PROJECT_ID=your_project_id
SANITY_DATASET=production
SANITY_TOKEN=your_write_token

# Craft Settings
CRAFT_API_URL=https://your-craft-api-url
CRAFT_TOKEN=your_craft_access_token
```

- `SANITY_PROJECT_ID` / `SANITY_DATASET` / `SANITY_TOKEN`  
  - Your Sanity project ID, dataset name, and an API token with at least Editor permissions.  
- `CRAFT_API_URL`  
  - The API endpoint URL shown when you enable “API” mode for a Craft document or folder.  
- `CRAFT_TOKEN`  
  - The API token issued on the same screen.  

### 2. Mapping configuration (config.json)

Default mappings are defined in `config.default.json`.  
If you need to customize them, copy it to `config.json` and edit the fields and metadata markers.

```json
{
  "sanity": {
    "post": {
      "type": "post",
      "fields": {
        "title": "title",
        "slug": "slug",
        "publishedAt": "publishedAt",
        "author": "author",
        "categories": "categories",
        "mainImage": "mainImage",
        "body": "body",
        "seoTitle": "seo.metaTitle"
      }
    }
  },
  "craft": {
    "metadata": {
      "slug": "Slug:",
      "author": "Author:",
      "category": "Category:",
      "publishedDate": "Published Date:",
      "excerpt": "Excerpt:",
      "featured": "Featured:",
      "tags": "Tags:",
      "seoTitle": "SEO Title:",
      "seoDescription": "SEO Description:"
    }
  }
}
```

- In `sanity.post.fields`, keys such as `title`, `slug`, or `body` represent logical values extracted from Craft, and the values specify where they should be stored in the Sanity document.  
- In `craft.metadata`, each value defines a line prefix in your Craft document that will be treated as a metadata field (e.g. any line starting with `Slug:` is parsed as a slug).  

## Preparing your Craft document

When writing in Craft Docs, add a few metadata lines at the top of the document.

Example:

```text
Slug: keyboard-review
Published Date: Sun, 30 Nov 2025
Author: Jane
Category: Keyboard
Tags: keyboard, review

---
Body starts here...
```

- The prefixes must match the markers defined in `craft.metadata` in your config file.  
- Adding a horizontal rule (`---`) between metadata and body makes the separation explicit, though the script primarily relies on the metadata markers.  

## Preparing Sanity

The tool works out of the box with the Sanity “Blog” starter, which defines `post`, `author`, and `category` schemas.  
For custom schemas, adjust `config.json` to point to your own document types and field paths.  

## Usage

### Save as draft (Draft mode)

Saves to Sanity as a `drafts.<id>` document.  
Useful for previewing and checking mappings before publishing.

```bash
npm run bridge -- "Part of the document title"
```

- The script looks up a Craft document by partial match on its title.  
- If no matching document is found, it prints the available titles and exits with an error.  

### Publish / update (Publish mode)

Creates or updates a published `post` document in Sanity.

```bash
npm run publish -- "Part of the document title"
```

- If a document with the same slug already exists, it is updated; otherwise, a new one is created.  
- In publish mode, the document is stored under a regular ID (without the `drafts.` prefix).  

## How it works

High-level flow:

1. Fetch the Craft document list via the Craft API and resolve the target document by (partial) title.  
2. Fetch the block content for that document and extract metadata lines from the top using the configured markers.  
3. Traverse body blocks: text blocks are converted to Portable Text, and image blocks are downloaded and re-uploaded to Sanity Assets.  
4. For Author and Category, the script looks up existing Sanity documents by name, falls back to a fuzzy match using Levenshtein distance, and creates new documents if nothing suitable is found.  
5. Using the slug, it locates an existing `post` in Sanity and either creates or updates a draft (`drafts.<id>`) or a published document depending on the selected mode.  

## Limitations / notes

- Currently focuses on text (including headings) and image blocks from Craft.  
- If your Craft structure or Sanity schemas differ significantly from the defaults, you may need to customize `config.json` and possibly the script.  
- The script logs detailed information to the console, which should help when debugging configuration or API issues.  

## License

MIT License.