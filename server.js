// --- Const collection ---
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { PDFDocument, rgb } = require('pdf-lib');
const { createExtractorFromData } = require('node-unrar-js');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Directories ---
const TEMP_DIR = path.join(os.tmpdir(), 'cbr-converter-files');
fs.ensureDirSync(TEMP_DIR);

// --- Storage Configuration ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, TEMP_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.cbr' || ext === '.cbz') {
            cb(null, true);
        } else {
            cb(new Error('Only CBR and CBZ files are allowed'));
        }
    }
});

// --- In-Memory Store for Metadata ---
const fileStore = new Map();

// --- Preview Cache ---
const previewCache = new Map();
const CACHE_MAX_SIZE = 100;

// --- Constants ---
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PREVIEW_TIMEOUT = 30000;

// --- Helper Functions ---
function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// Detect actual archive type by checking file signature
async function detectArchiveType(filePath) {
    const buffer = await fs.readFile(filePath);

    // Check for ZIP signature (PK)
    if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B) {
        return 'zip';
    }

    // Check for RAR signature
    if (buffer.length > 7 && buffer.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]))) {
        return 'rar';
    }

    // Fallback: try ZIP first (most common for CBR files)
    return 'zip';
}

async function getArchiveFileList(filePath, originalName) {
    let imageFiles = [];
    let type = await detectArchiveType(filePath);

    console.log(`Detected archive type for ${originalName}: ${type}`);

    // Try ZIP first (most CBR files are actually ZIP)
    if (type === 'zip') {
        try {
            const zip = new AdmZip(filePath);
            const zipEntries = zip.getEntries();
            zipEntries.forEach(entry => {
                if (!entry.isDirectory && /\.(jpg|jpeg|png|gif|webp)$/i.test(entry.entryName)) {
                    imageFiles.push(entry.entryName);
                }
            });
            if (imageFiles.length > 0) {
                imageFiles.sort(naturalSort);
                return { type: 'zip', imageFiles };
            }
        } catch (e) {
            console.log('ZIP extraction failed, trying RAR');
        }
    }

    // Try RAR
    if (type === 'rar' || imageFiles.length === 0) {
        try {
            const fileBuffer = await fs.readFile(filePath);
            const extractor = await createExtractorFromData({ data: fileBuffer });
            const list = extractor.getFileList();

            imageFiles = [];
            for (const header of list.fileHeaders) {
                if (header.flags.encrypted) {
                    console.warn(`[RAR] File is encrypted: ${header.name}`);
                    return { type: 'rar-encrypted', imageFiles: [] };
                }
                if (!header.flags.directory && /\.(jpg|jpeg|png|gif|webp)$/i.test(header.name)) {
                    imageFiles.push(header.name);
                }
            }

            if (imageFiles.length > 0) {
                imageFiles.sort(naturalSort);
                return { type: 'rar', imageFiles };
            }
        } catch (e) {
            console.log('RAR extraction also failed');
        }
    }

    imageFiles.sort(naturalSort);
    return { type: imageFiles.length > 0 ? type : 'unknown', imageFiles };
}

// --- Improved PQueue ---
class PQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.next();
        });
    }

    next() {
        if (this.running >= this.concurrency || this.queue.length === 0) {
            return;
        }

        this.running++;
        const { fn, resolve, reject } = this.queue.shift();

        Promise.resolve()
            .then(() => fn())
            .then(resolve)
            .catch(reject)
            .finally(() => {
                this.running--;
                this.next();
            });
    }
}

const extractionQueue = new PQueue(2);

// --- FIXED Image Extraction - Try ZIP first for CBR files ---
async function extractImageBuffer(filePath, type, imageName) {
    if (type === 'rar-encrypted') {
        throw new Error('File is password protected');
    }

    // Always try ZIP first (most CBR files are actually ZIP)
    try {
        const zip = new AdmZip(filePath);
        let entry = zip.getEntry(imageName);

        if (!entry) {
            // Try normalized paths
            const entries = zip.getEntries();
            entry = entries.find(e =>
                e.entryName === imageName ||
                e.entryName === imageName.replace(/\\/g, '/') ||
                e.entryName === imageName.replace(/\//g, '\\') ||
                e.entryName.endsWith(imageName.split(/[/\\]/).pop())
            );
        }

        if (entry) {
            return entry.getData();
        }
    } catch (zipError) {
        // ZIP failed, try RAR only if type suggests it's RAR
        if (type === 'rar') {
            try {
                const fileBuffer = await fs.readFile(filePath);
                const extractor = await createExtractorFromData({ data: fileBuffer });

                const pathVariations = [
                    imageName,
                    imageName.replace(/\//g, '\\'),
                    imageName.replace(/\\/g, '/'),
                    imageName.split(/[/\\]/).pop(),
                ];

                for (const pathVariant of pathVariations) {
                    try {
                        const extracted = extractor.extract({ files: [pathVariant] });

                        if (extracted.files && extracted.files.length > 0) {
                            const file = extracted.files[0];
                            if (file.extraction) {
                                return Buffer.from(file.extraction);
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }

                // Last attempt: extract all and find
                try {
                    const allFiles = extractor.extract();
                    const matchedFile = allFiles.files.find(f =>
                        f.fileHeader.name === imageName ||
                        f.fileHeader.name.endsWith(imageName.split(/[/\\]/).pop())
                    );

                    if (matchedFile && matchedFile.extraction) {
                        return Buffer.from(matchedFile.extraction);
                    }
                } catch (e) {
                    console.error('RAR extraction critical failure for ' + imageName + ':', e.message);
                }
            } catch (rarError) {
                console.error('RAR extraction critical failure for ' + imageName + ':', rarError.message);
                throw new Error(`RAR extraction failed: ${rarError.message}`);
            }
        }
    }

    throw new Error(`File '${imageName}' not found in archive`);
}

// --- Routes ---

// 1. Upload
app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

        const results = [];
        for (const file of files) {
            const fileId = path.parse(file.filename).name;
            const { type, imageFiles } = await getArchiveFileList(file.path, file.originalname);

            if (imageFiles.length === 0) {
                await fs.remove(file.path);
                continue;
            }

            const metadata = {
                id: fileId,
                originalName: file.originalname,
                filePath: file.path,
                type,
                totalPages: imageFiles.length,
                pages: imageFiles
            };

            fileStore.set(fileId, metadata);
            results.push({
                id: fileId,
                name: file.originalname,
                totalPages: imageFiles.length,
                size: file.size
            });
        }

        res.json({ success: true, files: results });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload processing failed' });
    }
});

// 2. Get File Pages
app.get('/api/files/:id', (req, res) => {
    const fileData = fileStore.get(req.params.id);
    if (!fileData) return res.status(404).json({ error: 'File not found' });

    res.json({
        id: fileData.id,
        name: fileData.originalName,
        pages: fileData.pages
    });
});

// 3. Get Thumbnail - FIXED VERSION
app.get('/api/preview/:id/:pageIndex', async (req, res) => {
    try {
        const { id, pageIndex } = req.params;
        const fileData = fileStore.get(id);

        if (!fileData) {
            return res.status(404).json({ error: 'File not found' });
        }

        const index = parseInt(pageIndex, 10);
        if (isNaN(index) || index < 0 || index >= fileData.pages.length) {
            return res.status(400).json({ error: 'Invalid page index' });
        }

        const imageName = fileData.pages[index];
        const cacheKey = `${id}-${pageIndex}`;

        // Check cache first
        if (previewCache.has(cacheKey)) {
            const cached = previewCache.get(cacheKey);
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=3600');
            return res.send(cached);
        }

        // Generate preview with timeout
        const result = await Promise.race([
            extractionQueue.add(async () => {
                try {
                    let buffer = await extractImageBuffer(fileData.filePath, fileData.type, imageName);

                    // Validate image
                    try {
                        const metadata = await sharp(buffer).metadata();
                        if (!metadata.width || !metadata.height) {
                            throw new Error('Invalid image dimensions');
                        }
                    } catch (metaError) {
                        console.error('Image validation failed:', metaError.message);
                        throw new Error('Corrupted or invalid image file');
                    }

                    // Process with Sharp
                    try {
                        buffer = await sharp(buffer)
                            .resize(300, 400, {
                                fit: 'inside',
                                withoutEnlargement: true
                            })
                            .jpeg({
                                quality: 60,
                                force: true
                            })
                            .toBuffer();

                        return { success: true, buffer };
                    } catch (sharpError) {
                        console.error('Sharp processing error:', sharpError.message);

                        // Fallback: try without resize
                        try {
                            buffer = await sharp(buffer)
                                .jpeg({ quality: 60, force: true })
                                .toBuffer();
                            return { success: true, buffer };
                        } catch (fallbackError) {
                            throw new Error(`Image processing failed: ${fallbackError.message}`);
                        }
                    }
                } catch (extractError) {
                    console.error(`Extraction failed for ${fileData.originalName}, page ${index}:`, extractError.message);
                    throw extractError;
                }
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Preview generation timeout')), PREVIEW_TIMEOUT)
            )
        ]);

        if (result.success) {
            // Cache the result
            if (previewCache.size >= CACHE_MAX_SIZE) {
                const firstKey = previewCache.keys().next().value;
                previewCache.delete(firstKey);
            }
            previewCache.set(cacheKey, result.buffer);

            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=3600');
            res.send(result.buffer);
        } else {
            throw new Error('Preview generation failed');
        }
    } catch (error) {
        console.error('Preview error:', error.message);
        res.status(500).json({
            error: 'Error generating preview',
            details: error.message
        });
    }
});

// 4. Delete File
app.delete('/api/files/:id', async (req, res) => {
    const { id } = req.params;
    const fileData = fileStore.get(id);

    if (fileData) {
        try {
            if (await fs.pathExists(fileData.filePath)) {
                await fs.remove(fileData.filePath);
            }
        } catch (e) {
            console.error("Delete error", e);
        }
        fileStore.delete(id);

        // Clear cached previews
        for (const key of previewCache.keys()) {
            if (key.startsWith(`${id}-`)) {
                previewCache.delete(key);
            }
        }
    }

    res.json({ success: true });
});

// 5. Convert
app.post('/api/convert', async (req, res) => {
    try {
        const { mode, globalSettings, jobs } = req.body;
        if (!jobs || jobs.length === 0) throw new Error('No jobs defined');

        console.log(`🚀 Starting Conversion: Mode=${mode}, Jobs=${jobs.length}`);

        const getImagesForJob = async (fileData, pageIndices) => {
            const targetNames = pageIndices.map(i => fileData.pages[i]).filter(Boolean);
            const imageBuffers = new Map();

            // Always try ZIP first
            try {
                const zip = new AdmZip(fileData.filePath);
                for (const name of targetNames) {
                    try {
                        let entry = zip.getEntry(name);
                        if (!entry) {
                            const entries = zip.getEntries();
                            entry = entries.find(e =>
                                e.entryName === name ||
                                e.entryName === name.replace(/\\/g, '/') ||
                                e.entryName === name.replace(/\//g, '\\')
                            );
                        }
                        if (entry) {
                            imageBuffers.set(name, entry.getData());
                        }
                    } catch (e) {
                        console.warn(`Failed to extract ${name} from ZIP`);
                    }
                }
            } catch (zipError) {
                // ZIP failed, try RAR if needed
                if (fileData.type === 'rar') {
                    try {
                        const fileBuffer = await fs.readFile(fileData.filePath);
                        const extractor = await createExtractorFromData({ data: fileBuffer });
                        const extracted = extractor.extract({ files: targetNames });

                        for (const file of extracted.files) {
                            if (file.extraction) {
                                imageBuffers.set(file.fileHeader.name, Buffer.from(file.extraction));
                            }
                        }
                    } catch (e) {
                        console.error(`RAR Batch Extraction Error for ${fileData.originalName}:`, e.message);
                    }
                }
            }

            return async (imageName) => {
                if (imageBuffers.has(imageName)) return imageBuffers.get(imageName);

                try {
                    console.warn(`Buffer missing for ${imageName}, trying fallback extract...`);
                    return await extractImageBuffer(fileData.filePath, fileData.type, imageName);
                } catch (e) {
                    console.error(`Final extraction failed for ${imageName}: ${e.message}`);
                    return null;
                }
            };
        };

        const processJob = async (job) => {
            const fileData = fileStore.get(job.fileId);
            if (!fileData) throw new Error(`File ${job.fileId} not found`);

            const pdfDoc = await PDFDocument.create();
            const pagesToProcess = job.pages !== null ? job.pages : fileData.pages.map((_, i) => i);
            const getImage = await getImagesForJob(fileData, pagesToProcess);

            const settings = { ...globalSettings };
            const bgColor = settings.bgColor || 'white';
            const quality = parseInt(settings.quality) || 80;

            for (const pageIndex of pagesToProcess) {
                const imageName = fileData.pages[pageIndex];
                if (!imageName) continue;

                const imgBuffer = await getImage(imageName);
                if (!imgBuffer) {
                    console.warn(`Skipping missing image: ${imageName}`);
                    continue;
                }

                try {
                    const sharpImg = sharp(imgBuffer);
                    const metadata = await sharpImg.metadata();

                    let processedBuffer;
                    if (metadata.format === 'png' && quality === 100) {
                        processedBuffer = await sharpImg.png().toBuffer();
                    } else {
                        processedBuffer = await sharpImg.jpeg({ quality }).toBuffer();
                    }

                    const metaRef = await sharp(processedBuffer).metadata();
                    let embeddedImage;

                    if (metaRef.format === 'png') {
                        embeddedImage = await pdfDoc.embedPng(processedBuffer);
                    } else {
                        embeddedImage = await pdfDoc.embedJpg(processedBuffer);
                    }

                    const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
                    const bgRgb = bgColor === 'black' ? rgb(0, 0, 0) : rgb(1, 1, 1);

                    page.drawRectangle({
                        x: 0,
                        y: 0,
                        width: A4_WIDTH,
                        height: A4_HEIGHT,
                        color: bgRgb
                    });

                    const { width, height } = embeddedImage;
                    const scale = Math.min(A4_WIDTH / width, A4_HEIGHT / height);
                    const drawWidth = width * scale;
                    const drawHeight = height * scale;

                    page.drawImage(embeddedImage, {
                        x: (A4_WIDTH - drawWidth) / 2,
                        y: (A4_HEIGHT - drawHeight) / 2,
                        width: drawWidth,
                        height: drawHeight
                    });
                } catch (e) {
                    console.error(`Page processing error ${imageName}:`, e.message);
                }
            }

            const pdfBytes = await pdfDoc.save();
            return {
                filename: fileData.originalName.replace(/\.(cbr|cbz)$/i, '.pdf'),
                data: Buffer.from(pdfBytes)
            };
        };

        if (mode === 'combine') {
            const mergedPdf = await PDFDocument.create();

            for (const job of jobs) {
                const fileData = fileStore.get(job.fileId);
                if (!fileData) continue;

                const pagesToProcess = job.pages !== null ? job.pages : fileData.pages.map((_, i) => i);
                const getImage = await getImagesForJob(fileData, pagesToProcess);
                const settings = globalSettings;
                const bgColor = settings.bgColor || 'white';
                const quality = parseInt(settings.quality) || 80;

                for (const pageIndex of pagesToProcess) {
                    const imageName = fileData.pages[pageIndex];
                    const imgBuffer = await getImage(imageName);
                    if (!imgBuffer) continue;

                    try {
                        const sharpImg = sharp(imgBuffer);
                        const processedBuffer = await sharpImg.jpeg({ quality }).toBuffer();
                        const embeddedImage = await mergedPdf.embedJpg(processedBuffer);
                        const page = mergedPdf.addPage([A4_WIDTH, A4_HEIGHT]);

                        const bgRgb = bgColor === 'black' ? rgb(0, 0, 0) : rgb(1, 1, 1);
                        page.drawRectangle({
                            x: 0,
                            y: 0,
                            width: A4_WIDTH,
                            height: A4_HEIGHT,
                            color: bgRgb
                        });

                        const scale = Math.min(A4_WIDTH / embeddedImage.width, A4_HEIGHT / embeddedImage.height);
                        const w = embeddedImage.width * scale;
                        const h = embeddedImage.height * scale;

                        page.drawImage(embeddedImage, {
                            x: (A4_WIDTH - w) / 2,
                            y: (A4_HEIGHT - h) / 2,
                            width: w,
                            height: h
                        });
                    } catch (err) {
                        console.error(`Combine page error:`, err.message);
                    }
                }
            }

            const mergedBytes = await mergedPdf.save();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="Combined_Output.pdf"`);
            res.send(Buffer.from(mergedBytes));
        } else {
            const results = [];
            for (const job of jobs) {
                results.push(await processJob(job));
            }

            if (results.length === 1) {
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${results[0].filename}"`);
                res.send(results[0].data);
            } else {
                const archive = archiver('zip', { zlib: { level: 9 } });
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', 'attachment; filename="converted_files.zip"');

                archive.pipe(res);
                results.forEach(f => archive.append(f.data, { name: f.filename }));
                await archive.finalize();
            }
        }
    } catch (error) {
        console.error('Conversion Failed:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/get-page-count', (req, res) => {
    res.json({ totalPages: 0 });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 CBR Adapter V2 running at http://localhost:${PORT}`);
    });
}

module.exports = app;
