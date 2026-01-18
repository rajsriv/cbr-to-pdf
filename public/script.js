// --- STATE ---
let appState = {
    mode: 'single', // single, batch, combine
    files: [], // Array of { id, name, totalPages, pages: [], selectedPages: Set (null = all), settings: {} }
    globalSettings: {
        bgColor: 'white',
        quality: 80
    },
    currentEditorFileIndex: null
};

// --- DOM ELEMENTS ---
const dom = {
    modeTabs: document.querySelectorAll('.mode-tab'),
    uploadContainer: document.getElementById('uploadContainer'),
    fileInput: document.getElementById('fileInput'),
    initialState: document.getElementById('initialState'),
    loadedState: document.getElementById('loadedState'),
    fileList: document.getElementById('fileList'),
    fileCount: document.getElementById('fileCount'),
    startBtn: document.getElementById('startBtn'),
    clearAllBtn: document.getElementById('clearAllBtn'),
    bgToggles: document.querySelectorAll('.toggle-opt'),
    qualityRange: document.getElementById('qualityRange'),
    qualityVal: document.getElementById('qualityVal'),
    singleSettings: document.getElementById('singleModeSettings'),
    combineSettings: document.getElementById('combineSettings'),
    openEditorBtn: document.getElementById('openEditorBtn'),
    editorModal: document.getElementById('editorModal'),
    editorGrid: document.getElementById('editorGrid'),
    editorFileName: document.getElementById('editorFileName'),
    closeEditorBtn: document.getElementById('closeEditorBtn'),
    saveEditorBtn: document.getElementById('saveEditorBtn'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    selectedCount: document.getElementById('selectedCount'),
    totalCount: document.getElementById('totalCount'),
    statusItem: document.querySelector('.status-active-mode'),
    mainProgress: document.getElementById('mainProgress'),
    rangeStart: document.getElementById('pageStart'),
    rangeEnd: document.getElementById('pageEnd')
};

// --- INITIALIZATION ---
function init() {
    setupEventListeners();
    updateUI();
}

function setupEventListeners() {
    // Mode Switching
    dom.modeTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            dom.modeTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            appState.mode = tab.dataset.mode;
            dom.statusItem.textContent = appState.mode.toUpperCase() + ' MODE';
            updateUI();
        });
    });

    // Upload
    dom.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    // Drag & Drop
    dom.uploadContainer.addEventListener('dragover', (e) => { e.preventDefault(); dom.uploadContainer.classList.add('drag-over'); });
    dom.uploadContainer.addEventListener('dragleave', () => dom.uploadContainer.classList.remove('drag-over'));
    dom.uploadContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        dom.uploadContainer.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });

    // Settings
    dom.bgToggles.forEach(btn => {
        btn.addEventListener('click', () => {
            dom.bgToggles.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.globalSettings.bgColor = btn.dataset.value;
        });
    });

    dom.qualityRange.addEventListener('input', (e) => {
        appState.globalSettings.quality = e.target.value;
        dom.qualityVal.textContent = e.target.value + '%';
    });

    dom.clearAllBtn.addEventListener('click', () => {
        // Optional: Call API to delete temporary files if we wanted to be strict
        appState.files = [];
        updateUI();
    });

    // Editor
    dom.openEditorBtn.addEventListener('click', openEditor);
    dom.closeEditorBtn.addEventListener('click', () => dom.editorModal.style.display = 'none');
    dom.saveEditorBtn.addEventListener('click', saveEditorState);
    dom.selectAllBtn.addEventListener('click', () => setEditorSelection(true));
    dom.deselectAllBtn.addEventListener('click', () => setEditorSelection(false));

    // Conversion
    dom.startBtn.addEventListener('click', startConversion);

    // Range Inputs (Simple)
    dom.rangeStart.addEventListener('change', updateRangeSettings);
    dom.rangeEnd.addEventListener('change', updateRangeSettings);
}

// --- FILE HANDLING ---
async function handleFiles(fileList) {
    if (!fileList.length) return;

    // Show loading state?
    dom.startBtn.textContent = "UPLOADING...";
    dom.startBtn.disabled = true;

    const formData = new FormData();
    let count = 0;
    for (let file of fileList) {
        if (file.name.match(/\.(cbr|cbz)$/i)) {
            formData.append('files', file);
            count++;
        }
    }

    if (count === 0) {
        alert('Only .cbr and .cbz files are allowed');
        dom.startBtn.textContent = "CONVERT →";
        dom.startBtn.disabled = false;
        return;
    }

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();

        if (result.success) {
            result.files.forEach(f => {
                appState.files.push({
                    id: f.id,
                    name: f.name,
                    totalPages: f.totalPages,
                    pages: null, // Loaded on demand
                    selectedPages: null // null means ALL
                });
            });
            updateUI();
        }
    } catch (err) {
        console.error(err);
        alert('Upload failed');
    } finally {
        dom.startBtn.textContent = "CONVERT →";
        dom.startBtn.disabled = false;
    }
}

// --- UI UPDATES ---
function updateUI() {
    const hasFiles = appState.files.length > 0;

    if (hasFiles) {
        dom.initialState.style.display = 'none';
        dom.loadedState.style.display = 'flex';
        renderFileList();
    } else {
        dom.initialState.style.display = 'flex';
        dom.loadedState.style.display = 'none';
    }

    dom.fileCount.textContent = appState.files.length;

    // Mode Specific Visibility
    if (appState.mode === 'single') {
        dom.singleSettings.style.display = 'block';
        dom.combineSettings.style.display = 'none';

        // Only enable Editor if exactly 1 file
        if (appState.files.length === 1) {
            dom.openEditorBtn.style.display = 'block';
            dom.rangeStart.disabled = false;
            dom.rangeEnd.disabled = false;
        } else {
            dom.openEditorBtn.style.display = 'none';
            dom.rangeStart.disabled = true;
            dom.rangeEnd.disabled = true;
        }
    } else if (appState.mode === 'combine') {
        dom.singleSettings.style.display = 'none';
        dom.combineSettings.style.display = 'block';

        // Initialize Sortable if needed
        if (dom.fileList._sortable) dom.fileList._sortable.option("disabled", false);
        else {
            dom.fileList._sortable = new Sortable(dom.fileList, {
                animation: 150,
                onEnd: (evt) => {
                    // Reorder Array
                    const item = appState.files.splice(evt.oldIndex, 1)[0];
                    appState.files.splice(evt.newIndex, 0, item);
                }
            });
        }
    } else { // Batch
        dom.singleSettings.style.display = 'none';
        dom.combineSettings.style.display = 'none';
        if (dom.fileList._sortable) dom.fileList._sortable.option("disabled", true);
    }
}

function renderFileList() {
    dom.fileList.innerHTML = '';
    appState.files.forEach((file, index) => {
        const row = document.createElement('div');
        row.className = 'file-item-row';
        row.innerHTML = `
            <div class="file-info">
                <span class="file-name">${file.name}</span>
                <span class="file-meta">${file.totalPages} pages ${file.selectedPages ? `• ${file.selectedPages.size} selected` : ''}</span>
            </div>
            <div class="file-actions">
                <button onclick="removeFile(${index})">×</button>
            </div>
        `;
        dom.fileList.appendChild(row);
    });
}

window.removeFile = function (index) {
    // Optionally call DELETE /api/files/:id
    appState.files.splice(index, 1);
    updateUI();
};

function updateRangeSettings() {
    if (appState.files.length !== 1) return;
    const file = appState.files[0];

    const start = parseInt(dom.rangeStart.value) || 1;
    const end = parseInt(dom.rangeEnd.value) || file.totalPages;

    // Convert logic to selected pages Set for consistency, or just keep simple ranges?
    // Let's use simple logic: If user uses range inputs, we clear the complex 'selectedPages' set and rely on API range logic
    // OR we generate the set. Generating set is more robust for the 'convert' function payload.

    const newSet = new Set();
    for (let i = start; i <= end; i++) {
        if (i <= file.totalPages) newSet.add(i - 1); // 0-indexed
    }
    file.selectedPages = newSet;
    renderFileList();
}

// --- EDITOR MODE ---
async function openEditor() {
    if (appState.files.length !== 1) return;
    appState.currentEditorFileIndex = 0;
    const file = appState.files[0];

    dom.editorModal.style.display = 'flex';
    dom.editorFileName.textContent = file.name;
    dom.editorGrid.innerHTML = '<div style="padding:20px;">Loading pages...</div>';

    // Fetch pages if not loaded
    if (!file.pages) {
        try {
            const res = await fetch(`/api/files/${file.id}`);
            const data = await res.json();
            file.pages = data.pages;
        } catch (e) {
            alert('Failed to load file info');
            dom.editorModal.style.display = 'none';
            return;
        }
    }

    // Initialize selectedPages if null (all)
    let tempSelection = new Set(file.selectedPages || file.pages.map((_, i) => i));

    renderEditorGrid(file, tempSelection);
}

function renderEditorGrid(file, tempSelection) {
    dom.editorGrid.innerHTML = '';
    dom.totalCount.textContent = file.pages.length;
    dom.selectedCount.textContent = tempSelection.size;

    // Use DocumentFragment for performance
    const frag = document.createDocumentFragment();

    file.pages.forEach((pageName, index) => {
        const isSelected = tempSelection.has(index);

        const card = document.createElement('div');
        card.className = `thumb-card ${isSelected ? 'selected' : 'removed'}`;
        card.innerHTML = `
            <img src="/api/preview/${file.id}/${index}" loading="lazy" alt="Page ${index + 1}">
            <div class="thumb-info">${index + 1}</div>
            <div class="thumb-removed-overlay">REMOVED</div>
        `;

        card.onclick = () => {
            if (tempSelection.has(index)) {
                tempSelection.delete(index);
                card.classList.remove('selected');
                card.classList.add('removed');
            } else {
                tempSelection.add(index);
                card.classList.add('selected');
                card.classList.remove('removed');
            }
            dom.selectedCount.textContent = tempSelection.size;
        };

        frag.appendChild(card);
    });

    dom.editorGrid.appendChild(frag);

    // Store temp selection on the DOM element for saving later
    dom.editorGrid._tempSelection = tempSelection;
}

function setEditorSelection(selectAll) {
    const file = appState.files[appState.currentEditorFileIndex];
    if (!file) return;

    const tempSelection = dom.editorGrid._tempSelection;
    tempSelection.clear();

    if (selectAll) {
        file.pages.forEach((_, i) => tempSelection.add(i));
    }

    // Re-render essentially just updates classes, but full render is easier to code
    renderEditorGrid(file, tempSelection);
}

function saveEditorState() {
    const file = appState.files[appState.currentEditorFileIndex];
    if (file && dom.editorGrid._tempSelection) {
        file.selectedPages = new Set(dom.editorGrid._tempSelection);
    }
    dom.editorModal.style.display = 'none';
    updateUI();
}


// --- CONVERSION ---
async function startConversion() {
    if (appState.files.length === 0) return;

    dom.startBtn.disabled = true;
    dom.mainProgress.style.display = 'block';
    dom.mainProgress.querySelector('.prog-fill').style.width = '20%';

    const jobs = appState.files.map(file => {
        let pages = null;
        if (file.selectedPages) {
            pages = Array.from(file.selectedPages).sort((a, b) => a - b);
        }
        return {
            fileId: file.id,
            pages: pages
        };
    });

    const payload = {
        mode: appState.mode,
        globalSettings: appState.globalSettings,
        jobs: jobs
    };

    try {
        dom.mainProgress.querySelector('.prog-fill').style.width = '50%';

        const response = await fetch('/api/convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error('Conversion failed');

        dom.mainProgress.querySelector('.prog-fill').style.width = '90%';

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);

        // Trigger Download
        const a = document.createElement('a');
        a.href = url;

        // Try to get filename from header
        const contentDisp = response.headers.get('Content-Disposition');
        let filename = 'converted.pdf';
        if (contentDisp && contentDisp.includes('filename=')) {
            filename = contentDisp.split('filename=')[1].replace(/"/g, '');
        }

        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        dom.mainProgress.querySelector('.prog-fill').style.width = '100%';
        setTimeout(() => {
            dom.mainProgress.style.display = 'none';
            dom.startBtn.disabled = false;
        }, 1000);

    } catch (error) {
        console.error(error);
        alert('Error during conversion: ' + error.message);
        dom.mainProgress.style.display = 'none';
        dom.startBtn.disabled = false;
    }
}

// Start
init();
