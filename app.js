(function () {
  "use strict";

  const els = {
    dropZone: document.getElementById("dropZone"),
    dropTitle: document.getElementById("dropTitle"),
    browseBtn: document.getElementById("browseBtn"),
    fileInput: document.getElementById("fileInput"),
    workPanel: document.getElementById("workPanel"),
    fileName: document.getElementById("fileName"),
    fileMeta: document.getElementById("fileMeta"),
    resetBtn: document.getElementById("resetBtn"),
    bitrateButtons: Array.from(document.querySelectorAll(".bitrate-option")),
    convertBtn: document.getElementById("convertBtn"),
    progressPanel: document.getElementById("progressPanel"),
    progressLabel: document.getElementById("progressLabel"),
    progressValue: document.getElementById("progressValue"),
    progressBar: document.getElementById("progressBar"),
    waveformWrap: document.getElementById("waveformWrap"),
    waveform: document.getElementById("waveform"),
    resultPanel: document.getElementById("resultPanel"),
    resultName: document.getElementById("resultName"),
    resultMeta: document.getElementById("resultMeta"),
    audioPreview: document.getElementById("audioPreview"),
    downloadBtn: document.getElementById("downloadBtn"),
    errorBox: document.getElementById("errorBox"),
  };

  const SUPPORTED_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
  const BLOCK_SIZE = 1152;

  let selectedFile = null;
  let pcmBuffer = null;
  let mp3Url = null;
  let bitrate = 128;
  let isConverting = false;

  init();

  function init() {
    bindEvents();
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function bindEvents() {
    els.dropZone.addEventListener("click", function (event) {
      if (event.target.closest("button")) {
        return;
      }
      openPicker();
    });

    els.dropZone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPicker();
      }
    });

    els.browseBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      openPicker();
    });

    els.fileInput.addEventListener("change", function () {
      handleFile(els.fileInput.files[0]);
    });

    ["dragenter", "dragover"].forEach(function (type) {
      els.dropZone.addEventListener(type, function (event) {
        event.preventDefault();
        if (!isConverting) {
          els.dropZone.classList.add("is-dragover");
        }
      });
    });

    ["dragleave", "drop"].forEach(function (type) {
      els.dropZone.addEventListener(type, function (event) {
        event.preventDefault();
        els.dropZone.classList.remove("is-dragover");
      });
    });

    els.dropZone.addEventListener("drop", function (event) {
      const file = event.dataTransfer.files[0];
      if (file) {
        handleFile(file);
      }
    });

    els.bitrateButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setBitrate(Number(button.dataset.bitrate));
      });
    });

    els.convertBtn.addEventListener("click", startConversion);
    els.resetBtn.addEventListener("click", resetAll);
  }

  function openPicker() {
    if (isConverting) {
      return;
    }
    els.fileInput.value = "";
    els.fileInput.click();
  }

  function handleFile(file) {
    if (!file || isConverting) {
      return;
    }

    if (!isSupportedFile(file)) {
      showError("请选择 MP4 或 M4A 文件。");
      return;
    }

    clearPreviousOutput();
    hideError();

    selectedFile = file;
    els.fileName.textContent = file.name;
    els.fileMeta.textContent = formatBytes(file.size) + " · MP4";
    els.dropTitle.textContent = "选择其他文件";
    els.workPanel.hidden = false;
    els.resultPanel.hidden = true;
    els.progressPanel.hidden = true;
    els.convertBtn.disabled = false;
    els.convertBtn.querySelector("span").textContent = "开始转换";
  }

  function isSupportedFile(file) {
    const name = file.name.toLowerCase();
    const validExtension = /\.(mp4|m4a)$/.test(name);
    const validType = ["video/mp4", "audio/mp4", "audio/x-m4a", "application/mp4"].indexOf(file.type) !== -1;
    return validExtension || validType;
  }

  function setBitrate(value) {
    bitrate = value;
    els.bitrateButtons.forEach(function (button) {
      const active = Number(button.dataset.bitrate) === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  async function startConversion() {
    if (!selectedFile || isConverting) {
      return;
    }

    isConverting = true;
    setBusyState(true);
    hideError();
    els.resultPanel.hidden = true;
    els.waveformWrap.hidden = true;
    showProgress("正在读取文件", 5, false);
    await nextFrame();

    try {
      const fileData = await selectedFile.arrayBuffer();
      showProgress("正在解码音频轨道", 14, true);
      await nextFrame();

      const decoded = await decodeFile(fileData);
      showProgress("正在准备编码", 50, false);
      pcmBuffer = await normalizeAudio(decoded);

      drawWaveform(pcmBuffer);
      showProgress("正在编码 MP3", 56, false);
      await nextFrame();

      const mp3Chunks = await encodeToMp3(pcmBuffer, bitrate);
      const blob = new Blob(mp3Chunks, { type: "audio/mpeg" });

      if (mp3Url) {
        URL.revokeObjectURL(mp3Url);
      }
      mp3Url = URL.createObjectURL(blob);
      finishConversion(blob);
    } catch (error) {
      console.error(error);
      showProgress("转换失败", 0, false);
      els.progressPanel.classList.add("is-error");
      showError(describeError(error));
    } finally {
      isConverting = false;
      setBusyState(false);
    }
  }

  function decodeFile(data) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();

    return new Promise(function (resolve, reject) {
      context.decodeAudioData(
        data,
        function (buffer) {
          if (context.close) {
            context.close().catch(function () {});
          }
          resolve(buffer);
        },
        function (error) {
          if (context.close) {
            context.close().catch(function () {});
          }
          reject(error);
        }
      );
    });
  }

  async function normalizeAudio(buffer) {
    const needsResample = !SUPPORTED_RATES.has(buffer.sampleRate);
    const needsDownmix = buffer.numberOfChannels > 2;

    if (!needsResample && !needsDownmix) {
      return buffer;
    }

    const targetRate = 44100;
    const length = Math.max(1, Math.ceil(buffer.duration * targetRate));
    const offline = new OfflineAudioContext(2, length, targetRate);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    return offline.startRendering();
  }

  function encodeToMp3(buffer, kbps) {
    const channels = buffer.numberOfChannels === 1 ? 1 : 2;
    const left = floatTo16BitPCM(buffer.getChannelData(0));
    const right = channels === 2 ? floatTo16BitPCM(buffer.getChannelData(1)) : null;
    const encoder = new lamejs.Mp3Encoder(channels, buffer.sampleRate, kbps);
    const chunks = [];
    const totalBlocks = Math.max(1, Math.ceil(left.length / BLOCK_SIZE));
    let blockIndex = 0;

    return new Promise(function (resolve, reject) {
      function encodeNextBlock() {
        try {
          const start = blockIndex * BLOCK_SIZE;
          const end = Math.min(left.length, start + BLOCK_SIZE);
          const leftBlock = left.subarray(start, end);
          const mp3 = channels === 2
            ? encoder.encodeBuffer(leftBlock, right.subarray(start, end))
            : encoder.encodeBuffer(leftBlock);

          if (mp3.length) {
            chunks.push(new Uint8Array(mp3));
          }

          blockIndex += 1;
          const progress = 56 + (blockIndex / totalBlocks) * 40;
          showProgress("正在编码 MP3", progress, false);

          if (blockIndex < totalBlocks) {
            if (blockIndex % 40 === 0) {
              requestAnimationFrame(encodeNextBlock);
            } else {
              encodeNextBlock();
            }
          } else {
            const tail = encoder.flush();
            if (tail.length) {
              chunks.push(new Uint8Array(tail));
            }
            showProgress("正在封装 MP3", 97, false);
            resolve(chunks);
          }
        } catch (error) {
          reject(error);
        }
      }

      encodeNextBlock();
    });
  }

  function finishConversion(blob) {
    const baseName = selectedFile.name.replace(/\.[^.]+$/, "") || "audio";
    const outputName = baseName + ".mp3";

    els.progressPanel.classList.remove("is-error");
    showProgress("转换完成", 100, false);
    els.resultName.textContent = outputName;
    els.resultMeta.textContent = formatBytes(blob.size) + " · " + bitrate + " kbps";
    els.audioPreview.src = mp3Url;
    els.audioPreview.load();
    els.downloadBtn.href = mp3Url;
    els.downloadBtn.download = outputName;
    els.resultPanel.hidden = false;
    els.convertBtn.querySelector("span").textContent = "再次转换";
  }

  function floatTo16BitPCM(input) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      let sample = input[i];
      sample = Math.max(-1, Math.min(1, sample));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  function drawWaveform(buffer) {
    els.waveformWrap.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const rect = els.waveform.getBoundingClientRect();
    const width = Math.max(2, Math.floor(rect.width * dpr));
    const height = Math.max(2, Math.floor(rect.height * dpr));
    els.waveform.width = width;
    els.waveform.height = height;

    const context = els.waveform.getContext("2d");
    const data = buffer.getChannelData(0);
    if (!data.length || !width) {
      return;
    }

    context.clearRect(0, 0, width, height);
    const mid = height / 2;
    const buckets = Math.floor(data.length / width);
    const scanStep = Math.max(1, Math.floor(buckets / 96));

    for (let x = 0; x < width; x += 1) {
      const start = x * buckets;
      const end = start + buckets;
      let min = 1;
      let max = -1;

      for (let i = start; i < end; i += scanStep) {
        const value = data[i];
        if (value < min) {
          min = value;
        }
        if (value > max) {
          max = value;
        }
      }

      const peak = Math.max(Math.abs(min), Math.abs(max));
      const barHeight = Math.max(1, peak * (height - 10));
      context.fillStyle = x < width * 0.72 ? "#27c96f" : "#35c6d9";
      context.fillRect(x, mid - barHeight / 2, 1, barHeight);
    }
  }

  function showProgress(label, value, busy) {
    els.progressPanel.hidden = false;
    els.progressPanel.classList.toggle("is-busy", Boolean(busy));
    els.progressPanel.classList.remove("is-error");
    els.progressLabel.textContent = label;
    els.progressValue.textContent = Math.round(value) + "%";
    els.progressBar.style.width = Math.max(0, Math.min(100, value)) + "%";
  }

  function showError(message) {
    els.errorBox.textContent = message;
    els.errorBox.hidden = false;
  }

  function hideError() {
    els.errorBox.textContent = "";
    els.errorBox.hidden = true;
  }

  function describeError(error) {
    const name = error && (error.name || error.code);
    if (name === "EncodingError" || name === "NotSupportedError") {
      return "无法解码该文件的音频轨道，请确认 MP4 使用 Edge 支持的音频编码。";
    }
    if (error && error.message) {
      return "转换失败：" + error.message;
    }
    return "转换失败，请换一个 MP4 文件重试。";
  }

  function setBusyState(busy) {
    els.convertBtn.disabled = busy || !selectedFile;
    els.resetBtn.disabled = busy;
    els.browseBtn.disabled = busy;
    els.dropZone.classList.toggle("is-busy", busy);
    els.dropZone.setAttribute("aria-disabled", String(busy));
  }

  function clearPreviousOutput() {
    if (mp3Url) {
      URL.revokeObjectURL(mp3Url);
      mp3Url = null;
    }
    pcmBuffer = null;
    els.audioPreview.removeAttribute("src");
    els.downloadBtn.removeAttribute("href");
    els.downloadBtn.removeAttribute("download");
    els.waveformWrap.hidden = true;
    els.progressPanel.classList.remove("is-error", "is-busy");
  }

  function resetAll() {
    if (isConverting) {
      return;
    }

    clearPreviousOutput();
    selectedFile = null;
    els.fileInput.value = "";
    els.fileName.textContent = "-";
    els.fileMeta.textContent = "-";
    els.dropTitle.textContent = "选择 MP4 文件";
    els.workPanel.hidden = true;
    els.resultPanel.hidden = true;
    els.progressPanel.hidden = true;
    els.errorBox.hidden = true;
    els.convertBtn.disabled = true;
    els.convertBtn.querySelector("span").textContent = "开始转换";
    els.dropZone.classList.remove("is-busy", "is-dragover");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, index);
    return value.toFixed(value >= 100 || index === 0 ? 0 : 1) + " " + units[index];
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(resolve);
    });
  }
})();
