document.addEventListener('DOMContentLoaded', () => {
    // --- Global State ---
    let playlist = [];
    let currentIndex = -1;
    let sentenceTimings = [];

    // --- Element References ---
    const convertBtn = document.getElementById('convertBtn');
    const textInput = document.getElementById('text');
    const filenameInput = document.getElementById('filename');
    const speakerSelect = document.getElementById('speaker');
    const toneInput = document.getElementById('tone');
    
    // Progress and Log elements
    const progressWrapper = document.getElementById('progressWrapper');
    const progressStatus = document.getElementById('progressStatus');
    const progressBar = document.getElementById('progressBar');
    const logWrapper = document.getElementById('logWrapper');
    const logBox = document.getElementById('logBox');
    const clearLogBtn = document.getElementById('clearLogBtn');
    
    // Player and History elements
    const historyTableBody = document.getElementById('historyTableBody');
    const audioPlayerWrapper = document.getElementById('audioPlayerWrapper');
    const audioElement = document.getElementById('audioElement');
    const playerStatusIcon = document.getElementById('playerStatusIcon');
    const playerDownloadBtn = document.getElementById('playerDownloadBtn');
    const playerFileInfo = document.getElementById('playerFileInfo');
    const playerTitle = document.getElementById('playerTitle');
    const playerCurrentSentence = document.getElementById('playerCurrentSentence');
    const playerSeek = document.getElementById('playerSeek');
    const playerCurrentTime = document.getElementById('playerCurrentTime');
    const playerDuration = document.getElementById('playerDuration');
    const playerPrevBtn = document.getElementById('playerPrevBtn');
    const playerPlayPause = document.getElementById('playerPlayPause');
    const playerNextBtn = document.getElementById('playerNextBtn');
    const playerVolume = document.getElementById('playerVolume');
    const transcriptToggle = document.getElementById('transcriptToggle');
    const transcriptContent = document.getElementById('transcriptContent');
    const transcriptIcon = document.getElementById('transcriptIcon');

    // --- Helper Functions ---
    const detectDirection = (text) => {
        const rtlRegex = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
        return rtlRegex.test(text) ? 'rtl' : 'ltr';
    };
    textInput.addEventListener('input', (e) => {
        e.target.dir = detectDirection(e.target.value);
    });
    const formatTime = (seconds) => {
        if (isNaN(seconds)) return "0:00";
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    };

    // --- Log Console Logic ---
    const addLog = (message, type = 'INFO') => {
        const timestamp = new Date().toLocaleTimeString();
        const logLine = document.createElement('div');
        logLine.innerHTML = `<span class="text-gray-500">${timestamp}</span> <span class="font-bold text-cyan-400">[${type}]</span> ${message}`;
        logBox.appendChild(logLine);
        logBox.scrollTop = logBox.scrollHeight;
    };
    clearLogBtn.addEventListener('click', () => { logBox.innerHTML = ''; });

    // --- Core Player Logic ---
    const playTrack = (index) => {
        if (index < 0 || index >= playlist.length) return;
        currentIndex = index;
        const track = playlist[index];
        audioPlayerWrapper.classList.remove('hidden');
        playerTitle.textContent = track.display_name;
        playerFileInfo.textContent = `| ${track.filesize}`;
        playerDownloadBtn.href = `/download/${track.id}?attachment=true`;
        audioElement.src = `/download/${track.id}`;

        if (track.text_content) {
            const direction = detectDirection(track.text_content);
            transcriptContent.dir = direction;
            playerCurrentSentence.dir = direction;
            const sentences = track.text_content.match(/[^.!?]+[.!?]+/g) || [track.text_content];
            transcriptContent.innerHTML = sentences.map((s, i) => `<span id="sentence-${i}" class="inline">${s.trim()}</span>`).join(' ');
        } else {
            transcriptContent.innerHTML = '<p class="text-gray-500">No transcript available.</p>';
        }

        audioElement.play();
        playerPrevBtn.disabled = currentIndex === 0;
        playerNextBtn.disabled = currentIndex === playlist.length - 1;

        audioElement.onloadedmetadata = () => {
            const totalDuration = audioElement.duration;
            if (!track.text_content) return;
            const totalChars = track.text_content.length;
            let cumulativeTime = 0;
            const sentences = track.text_content.match(/[^.!?]+[.!?]+/g) || [track.text_content];
            sentenceTimings = sentences.map(sentence => {
                const estimatedDuration = (sentence.length / totalChars) * totalDuration;
                const timing = { start: cumulativeTime, end: cumulativeTime + estimatedDuration, text: sentence.trim() };
                cumulativeTime += estimatedDuration;
                return timing;
            });
        };
    };

    // --- Player Event Listeners ---
    playerPlayPause.addEventListener('click', () => {
        if (audioElement.src && !audioElement.paused) audioElement.pause();
        else if (audioElement.src) audioElement.play();
        else if (playlist.length > 0) playTrack(0);
    });
    playerNextBtn.addEventListener('click', () => playTrack(currentIndex + 1));
    playerPrevBtn.addEventListener('click', () => playTrack(currentIndex - 1));
    audioElement.addEventListener('play', () => {
        playerPlayPause.innerHTML = '<i class="fas fa-pause-circle"></i>';
        playerStatusIcon.classList.add('fa-spin');
    });
    audioElement.addEventListener('pause', () => {
        playerPlayPause.innerHTML = '<i class="fas fa-play-circle"></i>';
        playerStatusIcon.classList.remove('fa-spin');
    });
    audioElement.addEventListener('ended', () => {
        if (currentIndex < playlist.length - 1) playTrack(currentIndex + 1);
        else {
            playerPlayPause.innerHTML = '<i class="fas fa-play-circle"></i>';
            playerStatusIcon.classList.remove('fa-spin');
        }
    });
    audioElement.addEventListener('timeupdate', () => {
        const currentTime = audioElement.currentTime;
        if (isNaN(currentTime) || isNaN(audioElement.duration)) return;
        playerSeek.value = (currentTime / audioElement.duration) * 100 || 0;
        playerCurrentTime.textContent = formatTime(currentTime);
        playerDuration.textContent = formatTime(audioElement.duration);
        let currentSentenceText = "---";
        document.querySelectorAll('#transcriptContent span').forEach(span => span.classList.remove('highlight-sentence'));
        if (sentenceTimings.length > 0) {
            const currentSentenceIndex = sentenceTimings.findIndex(s => currentTime >= s.start && currentTime < s.end);
            if (currentSentenceIndex !== -1) {
                const sentenceEl = document.getElementById(`sentence-${currentSentenceIndex}`);
                if (sentenceEl) {
                    sentenceEl.classList.add('highlight-sentence');
                    currentSentenceText = sentenceTimings[currentSentenceIndex].text;
                }
            }
        }
        playerCurrentSentence.textContent = currentSentenceText;
    });
    playerSeek.addEventListener('input', () => {
        if (audioElement.duration) audioElement.currentTime = (playerSeek.value / 100) * audioElement.duration;
    });
    playerVolume.addEventListener('input', () => { audioElement.volume = playerVolume.value; });
    transcriptToggle.addEventListener('click', () => {
        transcriptContent.classList.toggle('hidden');
        transcriptIcon.classList.toggle('fa-chevron-down');
        transcriptIcon.classList.toggle('fa-chevron-up');
    });

    // --- History Table & Data Fetching ---
    const handleDelete = async (fileId, displayName) => {
        if (!confirm(`آیا از حذف فایل «${displayName}» مطمئن هستید؟`)) return;
        try {
            await axios.delete(`/delete/${fileId}`);
            if (playerTitle.textContent === displayName) {
                audioPlayerWrapper.classList.add('hidden');
                audioElement.src = '';
                audioElement.pause();
            }
            fetchHistory();
        } catch (error) {
            console.error('Deletion failed:', error);
            alert('حذف فایل با خطا مواجه شد.');
        }
    };
    const fetchHistory = async () => {
        try {
            const response = await axios.get('/get_history');
            playlist = response.data;
            historyTableBody.innerHTML = '';
            if (playlist.length === 0) {
                historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-gray-500">تاریخچه‌ای وجود ندارد.</td></tr>';
                return;
            }
            playlist.forEach((item, index) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td class="px-6 py-4 whitespace-nowrap">${item.display_name}</td>
                    <td class="px-6 py-4 whitespace-nowrap">${item.speaker}</td>
                    <td class="px-6 py-4 whitespace-nowrap">${item.created_at}</td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${item.status === 'completed' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                            ${item.status === 'completed' ? 'موفق' : 'ناموفق'}
                        </span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-left text-sm font-medium">
                        <button class="text-blue-600 hover:text-blue-900 ml-3 play-btn" title="Play"><i class="fas fa-play-circle fa-lg"></i></button>
                        <button class="text-red-600 hover:text-red-900 delete-btn" title="Delete"><i class="fas fa-trash-alt fa-lg"></i></button>
                    </td>
                `;
                row.querySelector('.play-btn').addEventListener('click', () => playTrack(index));
                row.querySelector('.delete-btn').addEventListener('click', () => handleDelete(item.id, item.display_name));
                historyTableBody.appendChild(row);
            });
        } catch (error) {
            console.error('Failed to fetch history:', error);
            historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500">خطا در بارگذاری تاریخچه.</td></tr>';
        }
    };

    // --- Conversion Logic with Progress Updates ---
    convertBtn.addEventListener('click', async () => {
        if (!textInput.value.trim()) {
            alert('لطفاً متنی را برای تبدیل وارد کنید.');
            return;
        }

        convertBtn.disabled = true;
        convertBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> در حال ارسال...';
        progressWrapper.classList.remove('hidden');
        logWrapper.classList.remove('hidden');
        logBox.innerHTML = '';
        progressBar.style.width = '0%';
        progressBar.classList.remove('bg-green-500', 'bg-red-500');
        progressBar.classList.add('bg-blue-600', 'progress-bar-animated');
        addLog('درخواست تبدیل ارسال شد.');

        const formData = new FormData();
        formData.append('text', textInput.value);
        formData.append('filename', filenameInput.value);
        formData.append('speaker', speakerSelect.value);
        formData.append('tone', toneInput.value);

        try {
            const response = await axios.post('/convert', formData);
            if (!response.data.success) {
                throw new Error(response.data.error || 'سرور با خطا مواجه شد.');
            }
            const taskId = response.data.task_id;
            addLog(`پردازش با شناسه ${taskId} شروع شد.`);
            convertBtn.innerHTML = '<i class="fas fa-cog fa-spin"></i> در حال پردازش...';

            const eventSource = new EventSource(`/stream-logs/${taskId}`);

            eventSource.onmessage = (event) => {
                const logData = event.data;
                if (logData.startsWith('STATUS:')) {
                    progressStatus.textContent = logData.replace('STATUS:', '');
                    addLog(logData.replace('STATUS:', ''), 'وضعیت');
                } else if (logData.startsWith('PROGRESS:')) {
                    progressBar.style.width = `${logData.replace('PROGRESS:', '')}%`;
                } else if (logData.startsWith('INFO:')) {
                    addLog(logData.replace('INFO:', ''), 'اطلاعات');
                } else if (logData.startsWith('WARNING:')) {
                    addLog(logData.replace('WARNING:', ''), 'هشدار');
                } else if (logData.startsWith('ERROR:')) {
                    const errorMsg = logData.replace('ERROR:', '');
                    addLog(errorMsg, 'خطا');
                    progressBar.classList.remove('bg-blue-600', 'progress-bar-animated');
                    progressBar.classList.add('bg-red-500');
                    progressStatus.textContent = 'تبدیل ناموفق بود!';
                    eventSource.close();
                    resetConvertButton();
                } else if (logData === 'DONE') {
                    addLog('پردازش با موفقیت به اتمام رسید.', 'موفق');
                    progressBar.classList.remove('bg-blue-600', 'progress-bar-animated');
                    progressBar.classList.add('bg-green-500');
                    textInput.value = '';
                    filenameInput.value = '';
                    fetchHistory();
                    eventSource.close();
                    setTimeout(() => {
                        resetConvertButton();
                        progressWrapper.classList.add('hidden');
                    }, 2000);
                }
            };
            
            eventSource.onerror = () => {
                addLog('ارتباط با سرور قطع شد.', 'خطای اتصال');
                progressBar.classList.add('bg-red-500');
                progressStatus.textContent = 'خطا در ارتباط';
                eventSource.close();
                resetConvertButton();
            };

        } catch (error) {
            addLog(`ارسال درخواست ناموفق بود: ${error.message}`, 'خطا');
            progressBar.classList.add('bg-red-500');
            progressStatus.textContent = 'خطای اولیه';
            resetConvertButton();
        }
    });
    
    const resetConvertButton = () => {
        convertBtn.disabled = false;
        convertBtn.innerHTML = 'تبدیل به صوت';
    };

    // --- Initial Load ---
    fetchHistory();
});