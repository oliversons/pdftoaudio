# app.py
from flask import Flask, render_template, request, Response, stream_with_context, jsonify, send_from_directory
import sqlite3
import os
import re
import uuid
from datetime import datetime
import time
import threading
from concurrent.futures import ProcessPoolExecutor, as_completed
from google import genai
from google.genai import types
import wave

# --- Global dictionary to store progress logs ---
PROGRESS_LOGS = {}

# --- Configure the Gemini API Key ---
try:
    genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
except Exception as e:
    print(f"CRITICAL ERROR: Failed to configure Gemini API. Details: {e}")

app = Flask(__name__, static_folder='static')
AUDIO_DIR = 'converted_audio'
DB_NAME = 'database.db'

# --- Database Initialization (unchanged) ---
def init_db():
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS audio_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT, storage_name TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL, speaker TEXT NOT NULL, tone TEXT NOT NULL,
            text_content TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status TEXT NOT NULL DEFAULT 'pending'
        )
    ''')
    cursor.execute("PRAGMA table_info(audio_files)")
    columns = [c[1] for c in cursor.fetchall()]
    if 'status' not in columns:
        cursor.execute('ALTER TABLE audio_files ADD COLUMN status TEXT NOT NULL DEFAULT "completed"')
    if 'text_content' not in columns:
        cursor.execute('ALTER TABLE audio_files ADD COLUMN text_content TEXT')
    if 'display_name' not in columns:
        try:
            cursor.execute('ALTER TABLE audio_files RENAME COLUMN filename TO storage_name')
        except sqlite3.OperationalError:
            pass
        cursor.execute('ALTER TABLE audio_files ADD COLUMN display_name TEXT NOT NULL DEFAULT "unnamed.wav"')
    conn.commit()
    conn.close()
    print("Database initialized.")

# --- Helper: log to DB (unchanged) ---
def log_audio(storage_name, display_name, speaker, tone, text, status):
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    conn.execute(
        "INSERT INTO audio_files (storage_name, display_name, speaker, tone, text_content, created_at, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (storage_name, display_name, speaker, tone, text, datetime.now(), status)
    )
    conn.commit()
    conn.close()

# --- Text processing and TTS functions (unchanged) ---
def chunk_text(text, sentences_per_chunk=5):
    sentences = re.findall(r'[^.!?]+[.!?]?', text, flags=re.UNICODE)
    return [
        ''.join(sentences[i : i + sentences_per_chunk]).strip()
        for i in range(0, len(sentences), sentences_per_chunk)
        if ''.join(sentences[i : i + sentences_per_chunk]).strip()
    ]

def tts_chunk_pcm(text_chunk, speaker, tone):
    while True:
        try:
            client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
            prompt = f"Speak in a {tone} tone: {text_chunk}"
            resp = client.models.generate_content(
                model="models/gemini-2.5-flash-preview-tts", contents=prompt,
                config=types.GenerateContentConfig(response_modalities=["AUDIO"], speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=speaker))))
            )
            parts = getattr(resp.candidates[0].content, "parts", None)
            if parts and parts[0].inline_data.data:
                return parts[0].inline_data.data
            app.logger.warning(f"Empty audio response for chunk: '{text_chunk[:50]}...'. Skipping this chunk.")
            return None
        except Exception as e:
            msg = str(e)
            if "RESOURCE_EXHAUSTED" in msg:
                m = re.search(r"'retryDelay'\s*:\s*'(\d+)s'", msg)
                delay = int(m.group(1)) if m else 60
                app.logger.warning(f"Quota hit; sleeping {delay}s before retry...")
                time.sleep(delay)
                continue
            raise RuntimeError(f"TTS chunk failed permanently: {e}")

def generate_tts_full(text, out_path, speaker, tone, log_callback):
    try:
        log_callback("STATUS:تقسیم‌بندی متن به قطعات کوچک...")
        chunks = chunk_text(text, sentences_per_chunk=5)
        total_chunks = len(chunks)
        if total_chunks == 0:
            raise ValueError("Input text is empty or contains no valid sentences.")
        log_callback(f"INFO:متن به {total_chunks} قطعه تقسیم شد.")
        max_workers = min(os.cpu_count() or 1, total_chunks)
        log_callback(f"INFO:شروع پردازش موازی با {max_workers} پردازنده...")
        with ProcessPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(tts_chunk_pcm, chunk, speaker, tone): i for i, chunk in enumerate(chunks)}
            pcm_parts = [None] * total_chunks
            for i, fut in enumerate(as_completed(futures)):
                idx = futures[fut]
                try:
                    result_pcm = fut.result()
                    pcm_parts[idx] = result_pcm
                    if result_pcm is None:
                        log_callback(f"WARNING:قطعه {idx + 1} صوتی نشد و از آن صرف نظر شد.")
                except Exception as e:
                    log_callback(f"ERROR:پردازش قطعه {idx + 1} با خطای جدی مواجه شد: {e}")
                    pcm_parts[idx] = None
                progress = int(((i + 1) / total_chunks) * 90)
                log_callback(f"PROGRESS:{progress}")
                log_callback(f"STATUS:پردازش قطعه {i + 1} از {total_chunks} تکمیل شد.")
        log_callback("STATUS:تجمیع قطعات صوتی...")
        successful_parts = [pcm for pcm in pcm_parts if pcm is not None]
        if not successful_parts:
            raise RuntimeError("All text chunks failed to convert to audio.")
        with wave.open(out_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(24000)
            for pcm in successful_parts:
                wf.writeframes(pcm)
        log_callback("PROGRESS:100")
        log_callback("STATUS:فایل صوتی با موفقیت ایجاد شد.")
        log_callback("DONE")
    except Exception as e:
        app.logger.error(f"TTS background task failed: {e}")
        log_callback(f"ERROR:خطا در هنگام تبدیل: {e}")

# --- Flask Routes ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/stream-logs/<task_id>')
def stream_logs(task_id):
    def generate():
        sent_messages = 0
        while True:
            if task_id not in PROGRESS_LOGS: break
            all_messages = PROGRESS_LOGS.get(task_id, [])
            if len(all_messages) > sent_messages:
                for message in all_messages[sent_messages:]:
                    yield f"data: {message}\n\n"
                sent_messages = len(all_messages)
                if "DONE" in all_messages[-1] or "ERROR" in all_messages[-1]:
                    time.sleep(1)
                    if task_id in PROGRESS_LOGS: del PROGRESS_LOGS[task_id]
                    break
            time.sleep(0.5)
    return Response(generate(), mimetype='text/event-stream')

@app.route('/convert', methods=['POST'])
def convert():
    task_id = uuid.uuid4().hex
    PROGRESS_LOGS[task_id] = []
    
    def log_callback(message):
        PROGRESS_LOGS[task_id].append(message)

    try:
        text = request.form['text']
        base = "".join(c for c in (request.form['filename'].strip() or "output") if c.isalnum() or c in (" ", "_", "-"))
        display_name = f"{base}.wav"
        storage_name = f"{uuid.uuid4().hex[:8]}_{display_name}"
        os.makedirs(AUDIO_DIR, exist_ok=True)
        out_path = os.path.join(AUDIO_DIR, storage_name)
        speaker, tone = request.form['speaker'], request.form['tone']
        tts_thread = threading.Thread(target=generate_tts_full, args=(text, out_path, speaker, tone, log_callback))
        tts_thread.daemon = True
        tts_thread.start()
        def db_logger_and_cleanup():
            tts_thread.join()
            if "ERROR" not in "".join(PROGRESS_LOGS.get(task_id, [])):
                 log_audio(storage_name, display_name, speaker, tone, text, "completed")
        db_thread = threading.Thread(target=db_logger_and_cleanup)
        db_thread.daemon = True
        db_thread.start()
        return jsonify({"success": True, "task_id": task_id})
    except Exception as e:
        log_callback(f"ERROR:خطای اولیه: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/get_history')
def get_history():
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT id, display_name, speaker, tone, text_content, strftime('%Y-%m-%d %H:%M:%S', created_at) AS created_at, status FROM audio_files ORDER BY created_at DESC")
    history = []
    rows = cur.fetchall()
    for row in rows:
        r = dict(row)
        fn_res = cur.execute("SELECT storage_name FROM audio_files WHERE id = ?", (r['id'],)).fetchone()
        if fn_res:
            storage_name = fn_res['storage_name']
            path = os.path.join(AUDIO_DIR, storage_name)
            r['filesize'] = f"{round(os.path.getsize(path)/1024, 2)} KB" if os.path.exists(path) else "0 KB"
        else:
            r['filesize'] = "N/A"
        history.append(r)
    conn.close()
    return jsonify(history)

# --- CORRECTED download route ---
@app.route('/download/<int:file_id>')
def download(file_id):
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    res = conn.cursor().execute("SELECT storage_name FROM audio_files WHERE id = ?", (file_id,)).fetchone()
    conn.close()
    if not res: return "File not found", 404
    
    storage_name = res[0]
    file_path = os.path.join(AUDIO_DIR, storage_name)
    
    if not os.path.exists(file_path):
        return "File not found on disk", 404
        
    if request.args.get('attachment','').lower() == 'true':
        return send_from_directory(AUDIO_DIR, storage_name, as_attachment=True)

    range_header = request.headers.get('Range', None)
    size = os.path.getsize(file_path)
    start, end = 0, size - 1
    
    if range_header:
        m = re.search(r'bytes=(\d+)-(\d*)', range_header)
        if m:
            start = int(m.group(1))
            if m.group(2): end = int(m.group(2))
            
    if start >= size or end >= size:
        return Response(status=416)

    length = end - start + 1
    
    def generate_chunk():
        with open(file_path, 'rb') as f:
            f.seek(start)
            to_read = length
            # --- THIS IS THE FIX ---
            # This loop is now written clearly and correctly.
            while to_read > 0:
                chunk = f.read(min(4096, to_read))
                if not chunk:
                    break
                yield chunk
                to_read -= len(chunk)

    status_code = 206 if range_header else 200
    rv = Response(stream_with_context(generate_chunk()), status=status_code, mimetype="audio/wav")
    
    # These headers are now added on separate, clear lines.
    rv.headers.add('Content-Range', f'bytes {start}-{end}/{size}')
    rv.headers.add('Accept-Ranges', 'bytes')
    rv.headers.add('Content-Length', str(length))
    
    return rv

@app.route('/delete/<int:file_id>', methods=['DELETE'])
def delete_file(file_id):
    try:
        conn = sqlite3.connect(DB_NAME, check_same_thread=False)
        cur = conn.cursor()
        res = cur.execute("SELECT storage_name FROM audio_files WHERE id = ?", (file_id,)).fetchone()
        if not res: return jsonify({"success": False, "error": "File not found"}), 404
        storage_name = res[0]
        cur.execute("DELETE FROM audio_files WHERE id = ?", (file_id,)); conn.commit(); conn.close()
        path = os.path.join(AUDIO_DIR, storage_name)
        if os.path.exists(path): os.remove(path)
        return jsonify({"success": True, "message": f"Deleted {storage_name}"})
    except Exception as e:
        app.logger.error(f"Error deleting file: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    init_db()
    app.run(debug=True, threaded=True)