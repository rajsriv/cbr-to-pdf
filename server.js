const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PDFDocument, rgb } = require('pdf-lib');
const { createExtractorFromData } = require('node-unrar-js');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4.5 * 1024 * 1024 }, // Adjusted to Vercel Serverless limit (4.5MB)
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.cbr' || ext === '.cbz') {
            cb(null, true);
        } else {
            cb(new Error('Only CBR and CBZ files are allowed'));
        }
    }
});

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

// Check if buffer is a valid RAR archive
function isValidRAR(buffer) {
    if (!buffer || buffer.length < 7) return false;
    // RAR magic bytes: 52 61 72 21 1A 07 00 (Rar!\x1A\x07\x00)
    const rarSignature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]);
    return buffer.subarray(0, 7).equals(rarSignature);
}

// 🔧 FIXED: Check if buffer is a valid ZIP archive
function isValidZIP(buffer) {
    if (!buffer || buffer.length < 4) return false;
    // ZIP magic bytes: 50 4B 03 04 (PK\x03\x04)
    return buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
}

async function extractImagesFromRAR(fileBuffer) {
    try {
        const extractor = await createExtractorFromData({
            data: fileBuffer
        });
        
        const list = extractor.getFileList();
        const imageFiles = [];
        
        for (const fileHeader of list.fileHeaders) {
            if (/\.(jpg|jpeg|png|gif|webp)$/i.test(fileHeader.name)) {
                imageFiles.push(fileHeader.name);
            }
        }
        
        return { imageFiles, extractor };
    } catch (error) {
        throw new Error(`Failed to extract RAR archive: ${error.message}`);
    }
}

async function extractImagesFromZIP(fileBuffer) {
    try {
        const zip = new AdmZip(fileBuffer);
        const zipEntries = zip.getEntries();
        
        const imageFiles = [];
        const imageData = {};
        
        for (const entry of zipEntries) {
            if (!entry.isDirectory && /\.(jpg|jpeg|png|gif|webp)$/i.test(entry.name)) {
                imageFiles.push(entry.name);
                imageData[entry.name] = entry.getData();
            }
        }
        
        return { imageFiles, imageData };
    } catch (error) {
        throw new Error(`Failed to extract ZIP archive: ${error.message}`);
    }
}

function naturalSort(a, b) {
    const fileA = a.split(/[\\\/]/).pop().toLowerCase();
    const fileB = b.split(/[\\\/]/).pop().toLowerCase();
    
    const aaParts = fileA.match(/(\d+|\D+)/g) || [];
    const bParts = fileB.match(/(\d+|\D+)/g) || [];
    
    for (let i = 0; i < Math.max(aaParts.length, bParts.length); i++) {
        const partA = aaParts[i] || '';
        const partB = bParts[i] || '';
        
        if (/^\d+$/.test(partA) && /^\d+$/.test(partB)) {
            const numA = parseInt(partA, 10);
            const numB = parseInt(partB, 10);
            if (numA !== numB) return numA - numB;
        } else {
            if (partA !== partB) return partA.localeCompare(partB);
        }
    }
    return 0;
}

// Auto-detect archive type by magic bytes, fallback to extension
async function extractImagesFromArchive(fileBuffer, fileName) {
    let imageFiles, extractor, imageData;
    const ext = path.extname(fileName).toLowerCase();
    
    //Try to detect by magic bytes first
    const isRAR = isValidRAR(fileBuffer);
    const isZIP = isValidZIP(fileBuffer);
    
    // Determine which extractor to use
    let useRAR = false;
    let useZIP = false;
    
    if (isRAR) {
        useRAR = true;
    } else if (isZIP) {
        useZIP = true;
    } else if (ext === '.cbr') {
        useRAR = true;
    } else if (ext === '.cbz') {
        useZIP = true;
    } else {
        throw new Error('Cannot determine archive type. File may be corrupted.');
    }
    
    try {
        if (useRAR) {
            console.log('📦 Detected RAR archive format');
            const result = await extractImagesFromRAR(fileBuffer);
            imageFiles = result.imageFiles;
            extractor = result.extractor;
        } else if (useZIP) {
            console.log('📦 Detected ZIP archive format');
            const result = await extractImagesFromZIP(fileBuffer);
            imageFiles = result.imageFiles;
            imageData = result.imageData;
        } else {
            throw new Error('Unsupported archive format');
        }
    } catch (error) {
        console.error('Archive extraction error:', error.message);
        
        // If detection failed, try the alternative format
        if (useRAR && !isRAR) {
            console.log('⚠️  RAR detection failed, trying ZIP...');
            try {
                const result = await extractImagesFromZIP(fileBuffer);
                imageFiles = result.imageFiles;
                imageData = result.imageData;
                useRAR = false;
                useZIP = true;
            } catch (zipError) {
                throw new Error(`Failed to extract archive: ${error.message}`);
            }
        } else if (useZIP && !isZIP) {
            console.log('⚠️  ZIP detection failed, trying RAR...');
            try {
                const result = await extractImagesFromRAR(fileBuffer);
                imageFiles = result.imageFiles;
                extractor = result.extractor;
                useZIP = false;
                useRAR = true;
            } catch (rarError) {
                throw new Error(`Failed to extract archive: ${error.message}`);
            }
        } else {
            throw error;
        }
    }
    
    // Sort images
    imageFiles.sort(naturalSort);
    
    if (imageFiles.length === 0) {
        throw new Error('No images found in archive file');
    }
    
    console.log(`✅ Found ${imageFiles.length} images`);
    return { imageFiles, extractor, imageData };
}

async function createPDFFromImages(imageFiles, extractor, imageData, bgColor, quality, requiredImageFiles) {
    const extractedImages = [];
    
    if (extractor) {
        const extracted = extractor.extract({
            files: requiredImageFiles
        });
        
        const extractedMap = {};
        for (const file of extracted.files) {
            if (file.extraction) {
                const fullPath = file.fileHeader.name;
                extractedMap[fullPath] = {
                    name: fullPath,
                    data: Buffer.from(file.extraction)
                };
            }
        }
        
        for (const imagePath of requiredImageFiles) {
            if (extractedMap[imagePath]) {
                console.log(`${extractedImages.length + 1}. ${imagePath}`);
                extractedImages.push(extractedMap[imagePath]);
            }
        }
    } else if (imageData) {
        for (const imagePath of requiredImageFiles) {
            if (imageData[imagePath]) {
                console.log(`${extractedImages.length + 1}. ${imagePath}`);
                extractedImages.push({
                    name: imagePath,
                    data: imageData[imagePath]
                });
            }
        }
    }
    
    console.log(`✅ Total images extracted: ${extractedImages.length}\n`);
    
    const pdfDoc = await PDFDocument.create();
    
    for (const imageFile of extractedImages) {
        try {
            let imageDataBuffer = imageFile.data;
            const ext = path.extname(imageFile.name).toLowerCase();
            
            if (ext === '.png') {
                imageDataBuffer = await sharp(imageDataBuffer)
                    .png({ compressionLevel: Math.floor(quality / 20) })
                    .toBuffer();
            } else {
                imageDataBuffer = await sharp(imageDataBuffer)
                    .jpeg({ quality: quality, progressive: true })
                    .toBuffer();
            }
            
            const metadata = await sharp(imageDataBuffer).metadata();
            const imgWidth = metadata.width;
            const imgHeight = metadata.height;
            
            const margin = 0;
            const availableWidth = A4_WIDTH - (2 * margin);
            const availableHeight = A4_HEIGHT - (2 * margin);
            
            let finalWidth = availableWidth;
            let finalHeight = (imgWidth > 0) ? (availableWidth * imgHeight) / imgWidth : availableHeight;
            
            if (finalHeight > availableHeight) {
                finalHeight = availableHeight;
                finalWidth = (imgHeight > 0) ? (availableHeight * imgWidth) / imgHeight : availableWidth;
            }
            
            const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
            
            if (bgColor === 'black') {
                page.drawRectangle({
                    x: 0,
                    y: 0,
                    width: A4_WIDTH,
                    height: A4_HEIGHT,
                    color: rgb(0, 0, 0)
                });
            } else {
                page.drawRectangle({
                    x: 0,
                    y: 0,
                    width: A4_WIDTH,
                    height: A4_HEIGHT,
                    color: rgb(1, 1, 1)
                });
            }
            
            let image;
            if (ext === '.png') {
                image = await pdfDoc.embedPng(imageDataBuffer);
            } else {
                image = await pdfDoc.embedJpg(imageDataBuffer);
            }
            
            const xPos = (A4_WIDTH - finalWidth) / 2;
            const yPos = (A4_HEIGHT - finalHeight) / 2;
            
            page.drawImage(image, {
                x: xPos,
                y: yPos,
                width: finalWidth,
                height: finalHeight
            });
            
        } catch (err) {
            console.error(`Error processing image ${imageFile.name}:`, err.message);
        }
    }
    
    return await pdfDoc.save();
}

// Endpoint to get page count
app.post('/api/get-page-count', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const { imageFiles } = await extractImagesFromArchive(req.file.buffer, req.file.originalname);
        res.json({ totalPages: imageFiles.length });
        
    } catch (error) {
        console.error('Error getting page count:', error);
        res.status(500).json({ error: error.message || 'Failed to get page count' });
    }
});

// Single file conversion endpoint
app.post('/api/convert', upload.single('file'), async (req, res) => {
    let tempDir;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const bgColor = req.body.bgColor || 'white';
        const quality = parseInt(req.body.quality) || 75;
        let pageStart = parseInt(req.body.pageStart) || 1;
        let pageEnd = parseInt(req.body.pageEnd) || undefined;
        
        // Vercel friendly temp directory
        tempDir = path.join(os.tmpdir(), 'cbr_convert_' + Date.now().toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const { imageFiles, extractor, imageData } = await extractImagesFromArchive(req.file.buffer, req.file.originalname);
        
        if (!pageEnd || pageEnd > imageFiles.length) {
            pageEnd = imageFiles.length;
        }
        
        pageStart = Math.max(1, Math.min(pageStart, imageFiles.length));
        pageEnd = Math.max(pageStart, Math.min(pageEnd, imageFiles.length));
        
        const requiredImageFiles = imageFiles.slice(pageStart - 1, pageEnd);
        
        console.log(`📄 Converting pages ${pageStart} to ${pageEnd} (Total: ${requiredImageFiles.length} pages)`);
        
        const pdfBytes = await createPDFFromImages(imageFiles, extractor, imageData, bgColor, quality, requiredImageFiles);
        
        const fileName = req.file.originalname.replace(/\.(cbr|cbz)$/i, '.pdf');
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdfBytes.length);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(Buffer.from(pdfBytes));
        
        console.log(`✅ Conversion completed: ${fileName}\n`);
        
    } catch (error) {
        console.error('Conversion error:', error);
        res.status(500).json({ error: error.message || 'Conversion failed' });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('Checkup cleanup error', cleanupError);
            }
        }
    }
});

// Batch file conversion endpoint
app.post('/api/batch-convert', upload.array('files', 20), async (req, res) => {
    let tempDir;
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        const bgColor = req.body.bgColor || 'white';
        const quality = parseInt(req.body.quality) || 75;
        
        // Vercel friendly temp directory
        tempDir = path.join(os.tmpdir(), 'cbr_batch_' + Date.now().toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        console.log(`\n📦 Starting batch conversion of ${req.files.length} files...`);
        
        const pdfBuffers = [];
        
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            try {
                console.log(`[${i + 1}/${req.files.length}] Processing: ${file.originalname}`);
                
                const { imageFiles, extractor, imageData } = await extractImagesFromArchive(file.buffer, file.originalname);
                const requiredImageFiles = imageFiles.slice(0, imageFiles.length);
                
                const pdfBytes = await createPDFFromImages(imageFiles, extractor, imageData, bgColor, quality, requiredImageFiles);
                const pdfFileName = file.originalname.replace(/\.(cbr|cbz)$/i, '.pdf');
                
                pdfBuffers.push({
                    name: pdfFileName,
                    data: Buffer.from(pdfBytes)
                });
                
                console.log(`✅ ${pdfFileName} created`);
                
            } catch (error) {
                console.error(`❌ Error converting ${file.originalname}:`, error.message);
            }
        }
        
        if (pdfBuffers.length === 0) {
            return res.status(500).json({ error: 'No files could be converted' });
        }
        
        if (pdfBuffers.length === 1) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Length', pdfBuffers[0].data.length);
            res.setHeader('Content-Disposition', `attachment; filename="${pdfBuffers[0].name}"`);
            res.send(pdfBuffers[0].data);
        } else {
            const archive = archiver('zip', { zlib: { level: 9 } });
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename="converted-pdfs.zip"');
            archive.pipe(res);
            
            for (const pdf of pdfBuffers) {
                archive.append(pdf.data, { name: pdf.name });
            }
            
            await archive.finalize();
            console.log(`\n📦 Batch conversion completed! ${pdfBuffers.length} PDFs packed in ZIP\n`);
        }
        
    } catch (error) {
        console.error('Batch conversion error:', error);
        res.status(500).json({ error: error.message || 'Batch conversion failed' });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('Cleanup error', cleanupError);
            }
        }
    }
});

// For Vercel, we export the app. For local development, we listen.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 CBR to PDF Converter running at http://localhost:${PORT}`);
        console.log(`📚 Upload CBR/CBZ files to convert them to PDF`);
    });
}

module.exports = app;
