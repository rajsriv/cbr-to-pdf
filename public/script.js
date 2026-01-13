const fileInput = document.getElementById('fileInput');
const uploadContainer = document.getElementById('uploadContainer');
const initialState = document.getElementById('initialState');
const loadedState = document.getElementById('loadedState');
const fileList = document.getElementById('fileList');
const fileCount = document.getElementById('fileCount');
const startBtn = document.getElementById('startBtn');
const processingPopup = document.getElementById('processingPopup');
const popupContent = document.getElementById('popupContent');
const closePopup = document.getElementById('closePopup');

let selectedFiles = [];

// Event Listeners
fileInput.addEventListener('change', handleFiles);

// Drag & Drop
uploadContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadContainer.style.borderColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-orange');
});

uploadContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (selectedFiles.length === 0) {
        uploadContainer.style.borderColor = '#000';
    } else {
        uploadContainer.style.borderColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-orange');
    }
});

uploadContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    handleFileList(files);
});

closePopup.addEventListener('click', () => {
    processingPopup.style.display = 'none';
});

function handleFiles(e) {
    handleFileList(e.target.files);
}

function handleFileList(files) {
    if (!files.length) return;

    // Filter for cbr/cbz
    const validFiles = Array.from(files).filter(file =>
        file.name.toLowerCase().endsWith('.cbr') ||
        file.name.toLowerCase().endsWith('.cbz')
    );

    if (validFiles.length === 0) {
        alert('Please select .cbr or .cbz files only.');
        return;
    }

    selectedFiles = [...selectedFiles, ...validFiles];
    updateUI();
}

function updateUI() {
    if (selectedFiles.length > 0) {
        initialState.style.display = 'none';
        loadedState.style.display = 'flex';
        uploadContainer.classList.add('active-Orange');

        fileCount.textContent = selectedFiles.length;
        renderFileList();
    } else {
        initialState.style.display = 'flex';
        loadedState.style.display = 'none';
        uploadContainer.classList.remove('active-Orange');
        fileInput.value = ''; // Reset input
    }
}

function renderFileList() {
    fileList.innerHTML = '';
    selectedFiles.forEach((file, index) => {
        const row = document.createElement('div');
        row.className = 'file-item-row';
        row.innerHTML = `
            <span class="file-name">${file.name}</span>
            <button class="remove-file" onclick="removeFile(${index})">×</button>
        `;
        fileList.appendChild(row);
    });
}

window.removeFile = function (index) {
    selectedFiles.splice(index, 1);
    updateUI();
}

// Conversion Logic
startBtn.addEventListener('click', async () => {
    if (selectedFiles.length === 0) return;

    processingPopup.style.display = 'flex';
    popupContent.innerHTML = ''; // Clear previous

    // Create UI elements for each file first
    const progressUpdates = selectedFiles.map((file, index) => {
        const item = document.createElement('div');
        item.className = 'process-item';
        item.id = `process-${index}`;
        item.innerHTML = `
            <div class="process-info">
                <span style="max-width: 70%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">${file.name}</span>
                <span class="process-status pending">PENDING</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: 0%"></div>
            </div>
        `;
        popupContent.appendChild(item);
        return { file, index, element: item };
    });

    // Process sequentially or parallel. Parallel limit 3 for better UX/server load.
    const CONCURRENCY = 2;
    const queue = [...progressUpdates];
    const activeWorkers = [];

    async function processItem(item) {
        const { file, element } = item;
        const statusSpan = element.querySelector('.process-status');
        const progressFill = element.querySelector('.progress-fill');

        statusSpan.textContent = "PROCESSING...";
        statusSpan.className = "process-status pending";
        progressFill.style.width = "30%"; // Fake start

        const formData = new FormData();
        formData.append('file', file);
        formData.append('quality', '75'); // Default
        formData.append('bgColor', 'white'); // Default

        try {
            const response = await fetch('/api/convert', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error('Conversion failed');

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const pdfName = file.name.replace(/\.(cbr|cbz)$/i, '.pdf');

            progressFill.style.width = "100%";
            statusSpan.textContent = "DONE";
            statusSpan.className = "process-status done";

            // Add download link
            const linkContainer = document.createElement('div');
            linkContainer.style.marginTop = "5px";
            linkContainer.style.textAlign = "right";

            const downloadLink = document.createElement('a');
            downloadLink.href = url;
            downloadLink.download = pdfName;
            downloadLink.className = "download-link";
            downloadLink.textContent = "Download";

            linkContainer.appendChild(downloadLink);
            element.appendChild(linkContainer);

        } catch (error) {
            console.error(error);
            statusSpan.textContent = "ERROR";
            statusSpan.className = "process-status error";
            progressFill.style.backgroundColor = "red";
        }
    }

    async function worker() {
        while (queue.length > 0) {
            const item = queue.shift();
            await processItem(item);
        }
    }

    // Start workers
    const workers = Array(Math.min(CONCURRENCY, queue.length)).fill(null).map(() => worker());
    await Promise.all(workers);
});
