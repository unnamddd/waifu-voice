import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";
import "./style.css";

const canvas = document.getElementById("glCanvas");
const gl = canvas.getContext("webgl");
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
  const getSupportedMimeType = () => {
    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm'
    ];
    return types.find(type => MediaRecorder.isTypeSupported(type));
  };

  const mimeType = getSupportedMimeType();
  if (!mimeType) {
    throw new Error('No supported video MIME type found');
  }

  // Create a composite stream of both canvas and audio
  const canvasStream = canvas.captureStream(60);
  const audioDestination = audioContext.createMediaStreamDestination();
  analyser.connect(audioDestination);

  // Combine the streams
  const tracks = [
    ...canvasStream.getVideoTracks(),
    ...audioDestination.stream.getAudioTracks()
  ];
  const combinedStream = new MediaStream(tracks);

  mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType: mimeType,
    videoBitsPerSecond: 5000000
  });

  let startTime = 0;
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
      console.log(`Chunk size: ${event.data.size} bytes`);
    }
  };

  mediaRecorder.onstart = () => {
    startTime = Date.now();
    console.log('Recording started');
  };

  mediaRecorder.onstop = async () => {
    const duration = Date.now() - startTime;
    console.log(`Recording duration: ${duration}ms`);
    exportButton.textContent = 'Converting...';

    await new Promise(resolve => setTimeout(resolve, 100));

    const blob = new Blob(recordedChunks, { type: mimeType });
    console.log(`Total recorded size: ${blob.size} bytes`);

    if (blob.size < 1000) {
      throw new Error('Recording too small, likely failed');
    }

    try {
      const baseURL = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';
      const ffmpeg = new FFmpeg();

      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
        workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript"),
      });

      ffmpeg.on('log', console.log);
      ffmpeg.on('progress', ({ ratio }) => {
        console.log(`Conversion progress: ${(ratio * 100).toFixed(2)}%`);
        exportButton.textContent = `Converting: ${(ratio * 100).toFixed(0)}%`;
      });

      console.log('FFmpeg loaded successfully');
      const buffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);

      try {
        await ffmpeg.writeFile('input.webm', uint8Array);
        console.log('Input file written successfully');

        // First probe the input file
        await ffmpeg.exec(['-i', 'input.webm']);

        // More robust FFmpeg conversion command with audio
        await ffmpeg.exec([
          '-i', 'input.webm',
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-preset', 'fast',
          '-crf', '23',
          '-b:a', '192k',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-y',
          'output.mp4'
        ]);

        console.log('Conversion completed');
        const outputData = await ffmpeg.readFile('output.mp4');
        console.log('Output file read successfully');

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
        await cleanup(ffmpeg);
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

  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
}

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

float getWaveformY(float x) {
    float centerY = 0.5;
    float amplitude = 0.0;
    
    // Calculate wave amplitude based on audio data
    for(int i = 0; i < 64; i++) {
        float index = float(i);
        float verticalFactor = 1.0 - abs(x - 0.5) * 2.0;
        // Further reduced amplitude
        float audioInfluence = uAudioData[i] * 0.015 * verticalFactor;
        amplitude += audioInfluence;
    }
    
    return centerY + amplitude * sin(x * 30.0);
}

void main() {
    vec4 texColor = texture2D(uSampler, vTextureCoord);
    
    // Original gradient effect logic
    float audioInfluence = 0.0;
    for(int i = 0; i < 64; i++) {
        float index = float(i);
        float ypos = index / 64.0;
        float influence = uAudioData[i] * 0.3 * 
            (1.0 - smoothstep(0.0, 0.1, abs(ypos - (1.0 - vTextureCoord.y))));
        audioInfluence += influence;
    }
    
    vec2 distortedCoord = vTextureCoord;
    float wave = sin(vTextureCoord.x * 30.0 + audioInfluence * 5.0) * 0.005;
    distortedCoord.y -= wave * audioInfluence;
    
    vec4 finalColor = texture2D(uSampler, distortedCoord);
    float glow = audioInfluence * 0.5;
    finalColor.rgb += vec3(0.2, 0.4, 1.0) * glow;
    
    // Add waveform line with consistent thickness
    float waveY = getWaveformY(vTextureCoord.x);
    
    // Calculate distance from center of screen (horizontally)
    float distFromCenter = abs(vTextureCoord.x - 0.5);
    
    // Make line much thicker in the center
    float baseLineWidth = 0.003;
    float centerThicknessMultiplier = 4.0; // Increased center thickness
    float lineWidth = baseLineWidth * (1.0 + (1.0 - pow(distFromCenter, 0.5)) * centerThicknessMultiplier);
    
    // Calculate vertical distance to line, normalized by line width
    float distToLine = abs(vTextureCoord.y - waveY) / lineWidth;
    
    // Create consistent line thickness
    float lineStrength = smoothstep(1.0, 0.0, distToLine);
    
    // Add glow effect to the line
    float baseGlowWidth = 0.012;
    float glowWidth = baseGlowWidth * (1.0 + (1.0 - pow(distFromCenter, 0.5)) * 2.0);
    float glowStrength = smoothstep(1.0, 0.0, abs(vTextureCoord.y - waveY) / glowWidth) * 0.5;
    
    // Combine line and glow with original effect
    vec3 lineColor = vec3(0.2, 0.6, 0.85); // Light blue color
    finalColor.rgb = mix(finalColor.rgb, lineColor, lineStrength);
    finalColor.rgb += lineColor * glowStrength;
    
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
    exportButton.disabled = false;
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

  const normalizedData = Array.from(dataArray).map((value) => value / 255.0);

  gl.uniform1fv(programInfo.uniformLocations.uAudioData, normalizedData);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(programInfo.uniformLocations.uSampler, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  requestAnimationFrame(draw);
}

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

resizeCanvases();
const programInfo = initGL();
gl.clearColor(0.0, 0.0, 0.0, 1.0);
gl.clear(gl.COLOR_BUFFER_BIT);

async function cleanup(ffmpeg) {
  try {
    await ffmpeg.deleteFile('input.webm');
    await ffmpeg.deleteFile('output.mp4');
  } catch (e) {
    console.warn('Cleanup failed:', e);
  }
  await ffmpeg.terminate();
}

async function exportVideo() {
  if (isExporting || !audioBuffer) return;

  try {
    isExporting = true;
    exportButton.disabled = true;
    exportButton.textContent = 'Recording...';

    if (!mediaRecorder) {
      await setupRecorder();
    }

    recordedChunks = [];

    // Start recording with smaller timeslice for more frequent chunks
    mediaRecorder.start(500);

    const exportSource = audioContext.createBufferSource();
    exportSource.buffer = audioBuffer;
    exportSource.connect(analyser);

    // Don't connect to audioContext.destination as we're using mediaStreamDestination
    // analyser.connect(audioContext.destination);

    const cleanup = () => {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
      isPlaying = false;
    };

    exportSource.onended = cleanup;
    exportSource.onerror = (error) => {
      console.error('Audio playback error:', error);
      cleanup();
    };

    isPlaying = true;
    exportSource.start();
    draw();

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
