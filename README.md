# CBR to PDF Converter 📚

A fast, easy-to-use web application that converts CBR (Comic Book RAR) and CBZ (Comic Book ZIP) files to beautiful, optimized PDF documents. Perfect for reading comics on any device!

## Features ✨

- **Multi-format Support**: Handles both CBR and CBZ archive formats
- **Smart Format Detection**: Automatically detects archive type using magic bytes with fallback to file extension
- **Preserves Quality**: High-quality image processing with adjustable compression settings
  - You can select quality through a drag bar.
- **A4 Optimized**: Images are automatically scaled and centered for A4 paper size
- **Batch Conversion**: Convert multiple files at once and download as ZIP
- **Customization Options**:
  - Adjustable quality settings (1-100)
  - Background color selection (white/black)
  - Page range selection (convert specific pages)
- **Drag-and-Drop UI**: Clean, intuitive interface with drag-and-drop file upload
- **Large File Support**: Handles files up to 500MB

## Tech Stack 🛠️

- **Backend**: Node.js with Express.js
- **File Processing**: 
  - RAR extraction: `node-unrar-js`
  - ZIP extraction: `adm-zip`
  - Image processing: `sharp`
  - PDF generation: `pdf-lib` and `pdfkit`
- **Frontend**: HTML5 with vanilla JavaScript
- **File Upload**: Multer (in-memory storage)

## Installation 📦

### Prerequisites
- Node.js (v14 or higher)
- npm (comes with Node.js)

### Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/cbr-to-pdf-converter.git
   cd cbr-to-pdf-converter
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm start
   ```
   
   The server will start at `http://localhost:3000`

4. **Open in browser**
   ```
   http://localhost:3000
   ```

## Usage 🎯

### Single File Conversion
1. Click the drop zone or select files
2. Choose your preferences:
   - **Quality**: Adjust image quality (1-100)
   - **Background**: Select white or black background
   - **Pages**: Specify page range (optional)
3. Click "Convert to PDF"
4. PDF will download automatically

### Batch Conversion
1. Select multiple CBR/CBZ files
2. Set your preferences
3. Click "Convert All"
4. All PDFs will be zipped and downloaded together

## API Endpoints 🔌

### GET `/` 
Serves the main HTML interface

### POST `/api/get-page-count`
Get the total number of pages in an archive
- **Form Data**: `file` (multipart file upload)
- **Response**: `{ totalPages: number }`

### POST `/api/convert`
Convert a single file to PDF
- **Form Data**:
  - `file`: CBR/CBZ file
  - `bgColor`: 'white' or 'black'
  - `quality`: 1-100
  - `pageStart`: Starting page (optional)
  - `pageEnd`: Ending page (optional)
- **Response**: PDF file download

### POST `/api/batch-convert`
Convert multiple files to PDF(s)
- **Form Data**:
  - `files`: Multiple CBR/CBZ files (up to 20)
  - `bgColor`: 'white' or 'black'
  - `quality`: 1-100
- **Response**: Single PDF (if 1 file) or ZIP archive (if multiple)

## Project Structure 📁

```
cbr-to-pdf-converter/
├── server.js          # Express server & conversion logic
├── package.json       # Dependencies & scripts
├── index.html         # Frontend UI
└── public/            # Static files (served by Express)
```

## Key Features Explained 🔍

### Archive Format Detection
The converter uses magic byte signatures to detect file formats:
- **RAR**: `52 61 72 21 1A 07 00` (Rar!\x1A\x07\x00)
- **ZIP**: `50 4B 03 04` (PK\x03\x04)

Falls back to file extension if magic byte detection fails.

### Natural Sorting
Images are sorted naturally (1, 2, 3... not 1, 10, 100) to ensure correct page order even with different naming conventions.

### PDF Generation
- Images are automatically scaled to fit A4 dimensions (595.28 x 841.89 points)
- Maintains aspect ratio
- Centers images on page
- Supports both PNG and JPEG compression

## Configuration 🎛️

Edit `server.js` to modify:
- **PORT**: Default is 3000
- **MAX_FILE_SIZE**: Currently 500MB (`limits: { fileSize: 500 * 1024 * 1024 }`)
- **A4_DIMENSIONS**: `A4_WIDTH = 595.28`, `A4_HEIGHT = 841.89`

## Error Handling ✅

The application includes comprehensive error handling:
- File format validation
- Archive integrity checks
- Graceful fallback between RAR and ZIP detection
- Detailed error messages for debugging

## Performance Tips 🚀

- Quality setting of 75 (default) offers good balance between file size and quality
- Batch conversion is more efficient than converting files individually
- Large archives (500+ pages) may take a few minutes to process

## Development 👨‍💻

### Debugging
The server logs detailed information during conversion:
```
📦 Detected RAR archive format
✅ Found 200 images
✅ Total images extracted: 200
✅ Conversion completed: comic.pdf
```

### Dependencies Overview
| Package | Version | Purpose |
|---------|---------|---------|
| express | ^5.2.1 | Web server framework |
| multer | ^2.0.2 | File upload handling |
| pdf-lib | ^1.17.1 | PDF creation |
| pdfkit | ^0.17.2 | PDF toolkit |
| sharp | ^0.34.5 | Image processing |
| adm-zip | ^0.5.16 | ZIP extraction |
| node-unrar-js | ^2.0.2 | RAR extraction |
| archiver | ^7.0.1 | ZIP creation for batch downloads |

## Known Limitations ⚠️

- Maximum file size: 500MB (configurable)
- Maximum batch files: 20 at once
- Requires Node.js runtime
- Some systems may need additional RAR library dependencies

## Troubleshooting 🔧

**Q: "Cannot determine archive type" error**
- Ensure the file is a valid CBR or CBZ file
- Try renaming with correct extension

**Q: PDF quality is poor**
- Increase the quality setting (try 85-95)
- Note: Higher quality = larger file size

**Q: Server crashes with large files**
- Increase `MAX_FILE_SIZE` in server.js
- Try converting in smaller batches

**Q: Port 3000 already in use**
- Change the PORT variable in server.js
- Or kill the process using port 3000

## Future Enhancements 🚀

- [ ] Image rotation/correction options
- [ ] Watermark support
- [ ] Progress tracking for large conversions
- [ ] Web socket real-time status updates
- [ ] Database for conversion history
- [ ] Docker containerization
- [ ] CLI version for batch processing

## License 📄

This project is licensed under the ISC License.

## Contributing 🤝

Contributions are welcome! Please feel free to submit a Pull Request.

## Credits 🙏

Created as a practical solution for converting digital comic archives to portable PDF format.

---

**Made with ❤️ for comic readers everywhere**
