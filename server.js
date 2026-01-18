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
// Map<fileId, { originalName, filePath, type, totalPages, pages: [] }>
const fileStore = new Map();

// --- Constants ---
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

// --- Helper Functions ---

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function getArchiveFileList(filePath, originalName) {
    const ext = path.extname(originalName).toLowerCase();
    const fileBuffer = await fs.readFile(filePath);
    let imageFiles = [];
    let type = 'unknown';

    // Try RAR
    if (ext === '.cbr') {
        try {
            const extractor = await createExtractorFromData({ data: fileBuffer });
            const list = extractor.getFileList();
            for (const header of list.fileHeaders) {
                if (header.flags.encrypted) {
                    console.warn(`[RAR] File is encrypted: ${header.name}`);
                    type = 'rar-encrypted';
                }
                if (!header.flags.directory && /\.(jpg|jpeg|png|gif|webp)$/i.test(header.name)) {
                    imageFiles.push(header.name);
                }
            }
            if (type !== 'rar-encrypted') type = 'rar';
        } catch (e) { console.log('RAR check failed, trying ZIP fallback'); }
    }

    // Try ZIP (or fallback)
    if (type === 'unknown' || imageFiles.length === 0) {
        try {
            const zip = new AdmZip(filePath);
            const zipEntries = zip.getEntries();
            zipEntries.forEach(entry => {
                if (!entry.isDirectory && /\.(jpg|jpeg|png|gif|webp)$/i.test(entry.entryName)) {
                    imageFiles.push(entry.entryName);
                }
            });
            // If ZIP worked
            if (imageFiles.length > 0) type = 'zip';
        } catch (e) { /* ignore */ }
    }

    // Double check RAR magic bytes if still unknown
    if (type === 'unknown' && fileBuffer.length > 7 && fileBuffer.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]))) {
        try {
            const extractor = await createExtractorFromData({ data: fileBuffer });
            const list = extractor.getFileList();
            for (const header of list.fileHeaders) {
                if (!header.flags.directory && /\.(jpg|jpeg|png|gif|webp)$/i.test(header.name)) {
                    imageFiles.push(header.name);
                }
            }
            if (imageFiles.length > 0) type = 'rar';
        } catch (e) { }
    }

    imageFiles.sort(naturalSort);
    return { type, imageFiles };
}

async function extractImageBuffer(filePath, type, imageName) {
    if (type === 'rar-encrypted') {
        throw new Error('File is password protected');
    }
    if (type === 'rar') {
        const fileBuffer = await fs.readFile(filePath);
        const extractor = await createExtractorFromData({ data: fileBuffer });
        const extracted = extractor.extract({ files: [imageName] });

        if (extracted.files && extracted.files.length > 0) {
            const file = extracted.files[0];
            if (file.extraction) {
                return Buffer.from(file.extraction);
            } else {
                console.error(`RAR: File found but no extraction data for '${imageName}'`);
            }
        } else {
            console.error(`RAR: File '${imageName}' not found in extraction results.`);
            // content listing for debug
            // const list = extractor.getFileList();
            // console.log('Available files:', list.fileHeaders.map(h => h.name).slice(0, 5));
        }
    } else if (type === 'zip') {
        const zip = new AdmZip(filePath);
        const entry = zip.getEntry(imageName);
        if (entry) {
            return entry.getData();
        }
    }
    throw new Error('Image extraction failed');
}

// --- Routes ---

// 1. Upload
app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

        const results = [];

        for (const file of files) {
            const fileId = path.parse(file.filename).name; // UUID from diskStorage
            const { type, imageFiles } = await getArchiveFileList(file.path, file.originalname);

            if (imageFiles.length === 0) {
                // Invalid or empty, cleanup
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

// 2. Get File Pages (for editor)
app.get('/api/files/:id', (req, res) => {
    const fileData = fileStore.get(req.params.id);
    if (!fileData) return res.status(404).json({ error: 'File not found' });
    res.json({
        id: fileData.id,
        name: fileData.originalName,
        pages: fileData.pages
    });
});

// 3. Get Thumbnail
app.get('/api/preview/:id/:pageIndex', async (req, res) => {
    try {
        const { id, pageIndex } = req.params;
        const fileData = fileStore.get(id);
        if (!fileData) return res.status(404).send('File not found');

        const index = parseInt(pageIndex);
        if (index < 0 || index >= fileData.pages.length) return res.status(400).send('Invalid page index');

        const imageName = fileData.pages[index];
        let buffer = await extractImageBuffer(fileData.filePath, fileData.type, imageName);

        // Resize for thumbnail
        buffer = await sharp(buffer)
            .resize(300, 400, { fit: 'inside' })
            .jpeg({ quality: 60 })
            .toBuffer();

        res.set('Content-Type', 'image/jpeg');
        res.send(buffer);
    } catch (error) {
        console.error('Preview error:', error);
        res.status(500).send('Error');
    }
});

// 4. Delete File
app.delete('/api/files/:id', async (req, res) => {
    const { id } = req.params;
    const fileData = fileStore.get(id);
    if (fileData) {
        await fs.remove(fileData.filePath);
        fileStore.delete(id);
    }
    res.json({ success: true });
});

// 5. Convert (Central Endpoint)
app.post('/api/convert', async (req, res) => {
    try {
        const { mode, globalSettings, jobs } = req.body;

        if (!jobs || jobs.length === 0) throw new Error('No jobs defined');

        console.log(`🚀 Starting Conversion: Mode=${mode}, Jobs=${jobs.length}`);

        const processJob = async (job) => {
            const fileData = fileStore.get(job.fileId);
            if (!fileData) throw new Error(`File ${job.fileId} not found`);

            const pdfDoc = await PDFDocument.create();
            // Map selected page indices (which are integers) to image names
            const pagesToProcess = job.pages !== null ? job.pages : fileData.pages.map((_, i) => i);

            // Job settings override global (not fully used in frontend yet, but good for structure)
            const settings = { ...globalSettings };
            const bgColor = settings.bgColor || 'white';
            const quality = parseInt(settings.quality) || 80;

            for (const pageIndex of pagesToProcess) {
                const imageName = fileData.pages[pageIndex];
                if (!imageName) continue;

                try {
                    let imgBuffer = await extractImageBuffer(fileData.filePath, fileData.type, imageName);
                    const sharpImg = sharp(imgBuffer);
                    const metadata = await sharpImg.metadata();

                    let processedBuffer;
                    if (metadata.format === 'png' && quality === 100) {
                        processedBuffer = await sharpImg.png().toBuffer();
                    } else {
                        processedBuffer = await sharpImg.jpeg({ quality }).toBuffer();
                    }

                    let embeddedImage;
                    const metaRef = await sharp(processedBuffer).metadata(); // Reload meta for format
                    if (metaRef.format === 'png') {
                        embeddedImage = await pdfDoc.embedPng(processedBuffer);
                    } else {
                        embeddedImage = await pdfDoc.embedJpg(processedBuffer);
                    }

                    const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);

                    if (bgColor === 'black') {
                        page.drawRectangle({ x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT, color: rgb(0, 0, 0) });
                    } else {
                        page.drawRectangle({ x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT, color: rgb(1, 1, 1) });
                    }

                    const { width, height } = embeddedImage;
                    const scale = Math.min(A4_WIDTH / width, A4_HEIGHT / height);
                    const drawWidth = width * scale;
                    const drawHeight = height * scale;

                    const x = (A4_WIDTH - drawWidth) / 2;
                    const y = (A4_HEIGHT - drawHeight) / 2;

                    page.drawImage(embeddedImage, {
                        x, y, width: drawWidth, height: drawHeight
                    });
                } catch (e) {
                    console.error(`Page error ${imageName}:`, e.message);
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
                const settings = globalSettings;
                const bgColor = settings.bgColor || 'white';
                const quality = parseInt(settings.quality) || 80;

                for (const pageIndex of pagesToProcess) {
                    const imageName = fileData.pages[pageIndex];
                    try {
                        let imgBuffer = await extractImageBuffer(fileData.filePath, fileData.type, imageName);
                        const sharpImg = sharp(imgBuffer);

                        let readyBuffer = await sharpImg.jpeg({ quality }).toBuffer();
                        const embeddedImage = await mergedPdf.embedJpg(readyBuffer);

                        const page = mergedPdf.addPage([A4_WIDTH, A4_HEIGHT]);

                        if (bgColor === 'black') {
                            page.drawRectangle({ x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT, color: rgb(0, 0, 0) });
                        } else {
                            page.drawRectangle({ x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT, color: rgb(1, 1, 1) });
                        }

                        const scale = Math.min(A4_WIDTH / embeddedImage.width, A4_HEIGHT / embeddedImage.height);
                        const w = embeddedImage.width * scale;
                        const h = embeddedImage.height * scale;

                        page.drawImage(embeddedImage, {
                            x: (A4_WIDTH - w) / 2,
                            y: (A4_HEIGHT - h) / 2,
                            width: w,
                            height: h
                        });
                    } catch (err) { }
                }
            }

            const mergedBytes = await mergedPdf.save();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="Combined_Output.pdf"`);
            res.send(Buffer.from(mergedBytes));

        } else {
            // Single or Batch
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

// Legacy support for page count if needed, though mostly handled by upload now
app.post('/api/get-page-count', (req, res) => {
    res.json({ totalPages: 0 });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 CBR Adapter V2 running at http://localhost:${PORT}`);
    });
}

module.exports = app;
