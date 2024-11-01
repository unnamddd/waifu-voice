import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";
import "./style.css";

const canvas = document.getElementById("glCanvas");
const waveformCanvas = document.getElementById("waveform");
const gl = canvas.getContext("webgl");
const waveformCtx = waveformCanvas.getContext("2d");
const playButton = document.getElementById("playButton");

let audioContext;
let analyser;
let audioBuffer = null;
let source = null;
let isPlaying = false;
let texture;
let program;
let imageAspectRatio = 1;
let mediaRecorder;
let recordedChunks = [];
let isExporting = false;

async function setupRecorder() {
    const stream = canvas.captureStream(30);
    mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=h264',
        videoBitsPerSecond: 5000000
    });

    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    mediaRecorder.onstop = async () => {
        exportButton.textContent = 'Converting...';
        
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        
        try {
            // Initialize FFmpeg
            const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.4/dist/umd';
            const ffmpeg = new FFmpeg();
            
            await ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
                workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
            });

            // Log FFmpeg version to verify initialization
            await ffmpeg.exec(['-version']);
            console.log('FFmpeg loaded successfully');

            // Convert blob to buffer
            const buffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(buffer);

            try {
                // Write input file
                await ffmpeg.writeFile('input.webm', uint8Array);
                console.log('Input file written successfully');

                // Run conversion
                await ffmpeg.exec([
                    '-i', 'input.webm',
                    '-c:v', 'libx264',  // Changed to libx264 for better compatibility
                    '-preset', 'fast',
                    '-crf', '22',
                    'output.mp4'
                ]);
                console.log('Conversion completed');

                // Read the output
                const outputData = await ffmpeg.readFile('output.mp4');
                console.log('Output file read successfully');

                // Create download
                const mp4Blob = new Blob([outputData], { type: 'video/mp4' });
                const url = URL.createObjectURL(mp4Blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = 'visualization.mp4';
                a.click();
                
                URL.revokeObjectURL(url);

            } catch (error) {
                console.error('FFmpeg operation failed:', error);
                throw error;
            } finally {
                // Cleanup
                try {
                    await ffmpeg.deleteFile('input.webm');
                    await ffmpeg.deleteFile('output.mp4');
                } catch (e) {
                    console.warn('Cleanup failed:', e);
                }
                await ffmpeg.terminate();
            }

        } catch (error) {
            console.error('Export failed:', error);
            alert('Export failed. Please try again. Error: ' + error.message);
        }
        
        recordedChunks = [];
        exportButton.textContent = 'Export MP4';
        exportButton.disabled = false;
        isExporting = false;
    };
}

function resizeCanvases() {
  const width = 800;
  const height = width / imageAspectRatio;

  canvas.width = width;
  canvas.height = height;
  waveformCanvas.width = width;
  waveformCanvas.height = height; // Make waveform canvas same size as main canvas

  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
}

// Vertex shader
const vsSource = `
            attribute vec4 aVertexPosition;
            attribute vec2 aTextureCoord;
            varying vec2 vTextureCoord;
            void main() {
                gl_Position = aVertexPosition;
                vTextureCoord = aTextureCoord;
            }
        `;

const fsSource = `
    precision mediump float;
    varying vec2 vTextureCoord;
    uniform sampler2D uSampler;
    uniform float uAudioData[64];
    
    void main() {
        vec4 texColor = texture2D(uSampler, vTextureCoord);
        
        float audioInfluence = 0.0;
        for(int i = 0; i < 64; i++) {
            float index = float(i);
            float ypos = index / 64.0;
            // Use (1.0 - vTextureCoord.y) to flip the calculation
            float influence = uAudioData[i] * 0.3 * 
                (1.0 - smoothstep(0.0, 0.1, abs(ypos - (1.0 - vTextureCoord.y))));
            audioInfluence += influence;
        }
        
        vec2 distortedCoord = vTextureCoord;
        float wave = sin(vTextureCoord.x * 30.0 + audioInfluence * 5.0) * 0.005;
        // Subtract the wave instead of adding it
        distortedCoord.y -= wave * audioInfluence;
        
        vec4 finalColor = texture2D(uSampler, distortedCoord);
        float glow = audioInfluence * 0.5;
        finalColor.rgb += vec3(0.2, 0.4, 1.0) * glow;
        
        gl_FragColor = finalColor;
    }
`;

function initShaderProgram(gl, vsSource, fsSource) {
  const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
  const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  return program;
}

function loadShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function initBuffers(gl) {
  const positions = [-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  const textureCoords = [0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
  const textureCoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, textureCoordBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array(textureCoords),
    gl.STATIC_DRAW
  );

  return {
    position: positionBuffer,
    textureCoord: textureCoordBuffer,
  };
}

function initGL() {
  program = initShaderProgram(gl, vsSource, fsSource);
  const buffers = initBuffers(gl);

  const programInfo = {
    program: program,
    attribLocations: {
      vertexPosition: gl.getAttribLocation(program, "aVertexPosition"),
      textureCoord: gl.getAttribLocation(program, "aTextureCoord"),
    },
    uniformLocations: {
      uSampler: gl.getUniformLocation(program, "uSampler"),
      uAudioData: gl.getUniformLocation(program, "uAudioData"),
    },
  };

  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
  gl.vertexAttribPointer(
    programInfo.attribLocations.vertexPosition,
    2,
    gl.FLOAT,
    false,
    0,
    0
  );
  gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.textureCoord);
  gl.vertexAttribPointer(
    programInfo.attribLocations.textureCoord,
    2,
    gl.FLOAT,
    false,
    0,
    0
  );
  gl.enableVertexAttribArray(programInfo.attribLocations.textureCoord);

  return programInfo;
}

function loadImage(file) {
  const img = new Image();
  img.onload = () => {
    imageAspectRatio = img.width / img.height;
    resizeCanvases();

    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  img.src = URL.createObjectURL(file);
}

function drawWaveform(dataArray) {
  waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  const width = waveformCanvas.width;
  const height = waveformCanvas.height;
  const centerX = width / 2;
  const centerY = height / 2;

  // Create vertical gradient
  const gradient = waveformCtx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(52, 152, 219, 0.8)"); // Bottom (more opaque)
  gradient.addColorStop(0.5, "rgba(52, 152, 219, 0.4)"); // Middle (semi-transparent)
  gradient.addColorStop(1, "rgba(52, 152, 219, 0)"); // Top (transparent)

  // Calculate number of vertical sections
  const numSections = 40;
  const sectionHeight = height / numSections;

  // Create vertical wave paths
  waveformCtx.beginPath();
  waveformCtx.moveTo(width, centerY);

  // Left side of the wave
  const leftPoints = [];
  const rightPoints = [];

  for (let i = numSections; i >= 0; i--) {
    const x = i * sectionHeight;

    const dataIndex = Math.floor((i / numSections) * dataArray.length);
    const audioValue = dataArray[dataIndex] / 255.0;

    const verticalFactor = 1 - Math.abs(x / width - 0.5) * 2;
    const amplitude = width * 0.25 * audioValue * verticalFactor;

    const leftY = centerY - amplitude;
    const rightY = centerY + amplitude;

    leftPoints.push({ x: x, y: leftY });
    rightPoints.unshift({ x: x, y: rightY });
  }

  waveformCtx.moveTo(width, centerY);
  leftPoints.forEach((point, index) => {
    if (index === 0) {
      waveformCtx.lineTo(point.x, point.y);
    } else {
      const xc = (leftPoints[index - 1].x + point.x) / 2;
      const yc = (leftPoints[index - 1].y + point.y) / 2;
      waveformCtx.quadraticCurveTo(
        leftPoints[index - 1].x,
        leftPoints[index - 1].y,
        xc,
        yc
      );
    }
  });

  rightPoints.forEach((point, index) => {
    if (index === 0) {
      waveformCtx.lineTo(point.x, point.y);
    } else {
      const xc = (rightPoints[index - 1].x + point.x) / 2;
      const yc = (rightPoints[index - 1].y + point.y) / 2;
      waveformCtx.quadraticCurveTo(
        rightPoints[index - 1].x,
        rightPoints[index - 1].y,
        xc,
        yc
      );
    }
  });

  waveformCtx.lineTo(width, centerY);

  waveformCtx.fillStyle = gradient;
  waveformCtx.fill();

  waveformCtx.strokeStyle = "rgba(52, 152, 219, 0.5)";
  waveformCtx.lineWidth = 2;
  waveformCtx.shadowColor = "rgba(52, 152, 219, 0.5)";
  waveformCtx.shadowBlur = 15;
  waveformCtx.stroke();
}

async function setupAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 128;
  }
}

async function loadAudioFile(file) {
  try {
    await setupAudioContext();

    const reader = new FileReader();

    const audioData = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });

    audioBuffer = await audioContext.decodeAudioData(audioData);
    exportButton.disabled = false; // Enable export when audio is loaded
  } catch (error) {
    console.error("Error loading audio file:", error);
    alert("Error loading audio file. Please try another file.");
  }
}

function createAudioSource() {
  if (source) {
    source.stop();
    source.disconnect();
  }

  source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);
  analyser.connect(audioContext.destination);

  source.onended = () => {
    isPlaying = false;
    playButton.textContent = "Play";
  };

  return source;
}

function draw() {
  if (!texture || !isPlaying) return;

  gl.clear(gl.COLOR_BUFFER_BIT);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);

  drawWaveform(dataArray);

  const normalizedData = Array.from(dataArray).map((value) => value / 255.0);

  gl.uniform1fv(programInfo.uniformLocations.uAudioData, normalizedData);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(programInfo.uniformLocations.uSampler, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  requestAnimationFrame(draw);
}

// Event Listeners
document.getElementById("audioInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) {
    await loadAudioFile(file);
  }
});

document.getElementById("imageInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    loadImage(file);
  }
});

playButton.addEventListener("click", () => {
  if (!audioBuffer) return;

  if (!isPlaying) {
    createAudioSource();
    source.start(0);
    isPlaying = true;
    playButton.textContent = "Pause";
    draw();
  } else {
    source.stop();
    isPlaying = false;
    playButton.textContent = "Play";
  }
});

// Initial setup
resizeCanvases();
const programInfo = initGL();
gl.clearColor(0.0, 0.0, 0.0, 1.0);
gl.clear(gl.COLOR_BUFFER_BIT);

async function exportVideo() {
    if (isExporting) return;
    
    try {
        isExporting = true;
        exportButton.disabled = true;
        exportButton.textContent = 'Recording...';
        
        if (!mediaRecorder) {
            await setupRecorder();
        }
        
        recordedChunks = [];
        mediaRecorder.start(1000); // Record in 1-second chunks
        
        // Create new audio source for export
        const exportSource = audioContext.createBufferSource();
        exportSource.buffer = audioBuffer;
        exportSource.connect(analyser);
        analyser.connect(audioContext.destination);
        
        // Start playback
        exportSource.start();
        draw();
        
        // Stop recording when audio ends
        exportSource.onended = () => {
            if (mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
            isPlaying = false;
        };
        
    } catch (error) {
        console.error('Export setup failed:', error);
        alert('Export setup failed. Please try again. Error: ' + error.message);
        exportButton.textContent = 'Export MP4';
        exportButton.disabled = false;
        isExporting = false;
    }
}

exportButton.addEventListener("click", exportVideo);
document.getElementById("playButton").style.display = "none";
