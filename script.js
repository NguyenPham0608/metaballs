// WebGL vertex shader
const vertexShaderSource = `
attribute vec2 a_position;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// FIXED WebGL fragment shader for proper color blending
const fragmentShaderSource = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_balls[3];
uniform vec3 u_colors[3];
uniform float u_radii[3];
uniform float u_threshold;
uniform float u_glow;

float fieldFalloff(float dist, float radius) {
    float normalizedDist = dist / (radius * 3.0); // matches Canvas2D “3x radius” soft falloff
    return pow(max(0.0, 1.0 - normalizedDist), 2.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy;
    float totalField = 0.0;
    vec3 weightedColor = vec3(0.0);

    // Accumulate weighted colors
    for (int i = 0; i < 3; i++) {
        vec2 ballPos = u_balls[i].xy;
        float radius = u_radii[i];
        float dist = distance(uv, ballPos);

        float field = fieldFalloff(dist, radius);
        totalField += field;
        weightedColor += u_colors[i] * field;
    }

    if (totalField > u_threshold * 0.003) {
        vec3 mixedColor = weightedColor / totalField; // hue preserved

        // Core & halo masks
        float core = smoothstep(u_threshold * 0.003, u_threshold * 0.005, totalField);
        float halo = smoothstep(u_threshold * 0.0005, u_threshold * 0.04, totalField);

        // Brightness only affects alpha, not RGB directly
        float brightness = pow(totalField, 0.4);

        float alpha = (core * u_glow * 0.03 * brightness) +
                    (halo * 0.3 * brightness);

        // ✅ Color stays normalized, only alpha drives strength
        gl_FragColor = vec4(mixedColor, min(0.95, alpha));

    } else {
        gl_FragColor = vec4(0.0);
    }
}
`;


class OptimizedMetaballs {
    constructor() {
        this.canvas2d = document.getElementById('canvas');
        this.canvasWebGL = document.getElementById('canvasWebGL');
        this.currentCanvas = this.canvas2d;

        this.useWebGL = false;
        this.gl = null;
        this.ctx = null;
        this.program = null;
        this.uniforms = {};

        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.quality = 1.0;

        this.config = {
            resolution: 10,
            threshold: 200,
            speed: 10,
            glow: 130
        };

        this.metaballs = [
            {
                x: this.width * 0.5,
                y: this.height * 0.5,
                radius: 80,
                color: [0, 1, 1], // Cyan
                angle: 0,
                orbitRadius: 80,
                orbitSpeed: 0.02,
                isDragging: false
            },
            {
                x: this.width * 0.5 + 100,
                y: this.height * 0.5 - 50,
                radius: 80,
                color: [1, 0, 1], // Magenta
                angle: Math.PI * 2 / 3,
                orbitRadius: 200,
                orbitSpeed: 0.015,
                isDragging: false
            },
            {
                x: this.width * 0.5 - 80,
                y: this.height * 0.5 + 80,
                radius: 80,
                color: [1, 1, 0], // Yellow
                angle: Math.PI * 4 / 3,
                orbitRadius: 120,
                orbitSpeed: 0.025,
                isDragging: false
            }
        ];

        this.mouse = {
            x: this.width / 2,
            y: this.height / 2,
            isDragging: false,
            draggedBall: null,
            offset: { x: 0, y: 0 }
        };

        this.fps = 60;
        this.frameCount = 0;
        this.lastTime = performance.now();

        // Pre-calculate constants
        this.TWO_PI = Math.PI * 2;
        this.centerX = this.width * 0.5;
        this.centerY = this.height * 0.5;

        // Optimized render data
        this.imageData = null;
        this.data32 = null;

        // Animation control
        this.animationId = null;
        this.init();
        this.switchMode();
    }

    init() {
        this.initCanvas2D();
        this.initWebGL();
        this.resize();
        this.setupEventListeners();
        this.animate();
    }

    initWebGL() {
        this.gl = this.canvasWebGL.getContext('webgl') || this.canvasWebGL.getContext('experimental-webgl');

        if (!this.gl) {
            console.warn('WebGL not supported');
            return false;
        }

        const gl = this.gl;

        // Create shaders
        const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

        if (!vertexShader || !fragmentShader) {
            return false;
        }

        // Create program
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.error('Unable to initialize shader program');
            return false;
        }

        // Set up geometry (full screen quad)
        const positions = new Float32Array([
            -1, -1,
            1, -1,
            -1, 1,
            1, 1,
        ]);

        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        const positionLocation = gl.getAttribLocation(this.program, 'a_position');
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        // Get uniform locations
        this.uniforms = {
            resolution: gl.getUniformLocation(this.program, 'u_resolution'),
            time: gl.getUniformLocation(this.program, 'u_time'),
            balls: gl.getUniformLocation(this.program, 'u_balls'),
            colors: gl.getUniformLocation(this.program, 'u_colors'),
            radii: gl.getUniformLocation(this.program, 'u_radii'),
            threshold: gl.getUniformLocation(this.program, 'u_threshold'),
            glow: gl.getUniformLocation(this.program, 'u_glow')
        };

        // Enable blending
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        return true;
    }

    initCanvas2D() {
        this.ctx = this.canvas2d.getContext('2d');
        if (this.ctx) {
            this.imageData = this.ctx.createImageData(this.canvas2d.width, this.canvas2d.height);
            this.data32 = new Uint32Array(this.imageData.data.buffer);
        }
    }

    createShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    switchMode() {
        this.useWebGL = !this.useWebGL;

        if (this.useWebGL && this.gl) {
            this.canvas2d.style.display = 'none';
            this.canvasWebGL.style.display = 'block';
            this.currentCanvas = this.canvasWebGL;
            document.getElementById('toggleMode').textContent = 'Switch to Canvas2D';
        } else {
            this.canvasWebGL.style.display = 'none';
            this.canvas2d.style.display = 'block';
            this.currentCanvas = this.canvas2d;
            document.getElementById('toggleMode').textContent = 'Switch to WebGL';

            // Reinitialize Canvas2D context if needed
            if (!this.ctx) {
                this.initCanvas2D();
            }
        }

        this.resize();
    }

    setupEventListeners() {
        // Mouse events - bind to both canvases
        const setupCanvasEvents = (canvas) => {
            canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
            canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
            canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
            canvas.addEventListener('mouseleave', this.handleMouseUp.bind(this));

            canvas.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
            canvas.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
            canvas.addEventListener('touchend', this.handleMouseUp.bind(this), { passive: false });
        };

        setupCanvasEvents(this.canvas2d);
        setupCanvasEvents(this.canvasWebGL);

        // Controls
        document.getElementById('resolution').addEventListener('input', (e) => {
            this.config.resolution = parseInt(e.target.value);
            document.getElementById('resValue').textContent = e.target.value;
        });

        document.getElementById('threshold').addEventListener('input', (e) => {
            this.config.threshold = parseInt(e.target.value);
            document.getElementById('thresholdValue').textContent = e.target.value;
        });

        document.getElementById('speed').addEventListener('input', (e) => {
            this.config.speed = parseInt(e.target.value);
            document.getElementById('speedValue').textContent = e.target.value;
        });

        document.getElementById('glow').addEventListener('input', (e) => {
            this.config.glow = parseInt(e.target.value);
            document.getElementById('glowValue').textContent = e.target.value;
        });

        document.getElementById('quality').addEventListener('input', (e) => {
            this.quality = parseFloat(e.target.value);
            document.getElementById('qualityValue').textContent = this.quality.toFixed(1);
            this.resize();
        });

        document.getElementById('toggleMode').addEventListener('click', () => {
            this.switchMode();
        });

        // Resize
        window.addEventListener('resize', this.resize.bind(this));
    }

    handleMouseDown(e) {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;

        const ball = this.getMetaballUnderMouse(this.mouse.x, this.mouse.y);
        if (ball) {
            this.mouse.isDragging = true;
            this.mouse.draggedBall = ball;
            this.mouse.offset.x = this.mouse.x - ball.x;
            this.mouse.offset.y = this.mouse.y - ball.y;
            ball.isDragging = true;
            this.currentCanvas.style.cursor = 'grabbing';
        }
    }

    handleMouseMove(e) {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;

        if (this.mouse.isDragging && this.mouse.draggedBall) {
            this.mouse.draggedBall.x = this.mouse.x - this.mouse.offset.x;
            this.mouse.draggedBall.y = this.mouse.y - this.mouse.offset.y;
        } else {
            const ball = this.getMetaballUnderMouse(this.mouse.x, this.mouse.y);
            this.currentCanvas.style.cursor = ball ? 'grab' : 'default';
        }
    }

    handleMouseUp() {
        if (this.mouse.draggedBall) {
            this.mouse.draggedBall.isDragging = false;
            this.mouse.draggedBall = null;
        }
        this.mouse.isDragging = false;
        this.currentCanvas.style.cursor = 'default';
    }

    handleTouchStart(e) {
        e.preventDefault();
        const touch = e.touches[0];
        this.mouse.x = touch.clientX;
        this.mouse.y = touch.clientY;
        this.handleMouseDown({ clientX: touch.clientX, clientY: touch.clientY });
    }

    handleTouchMove(e) {
        e.preventDefault();
        const touch = e.touches[0];
        this.handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
    }

    getMetaballUnderMouse(x, y) {
        for (let i = this.metaballs.length - 1; i >= 0; i--) {
            const ball = this.metaballs[i];
            const dx = x - ball.x;
            const dy = y - ball.y;
            if (dx * dx + dy * dy <= ball.radius * ball.radius) {
                return ball;
            }
        }
        return null;
    }

    resize() {
        this.width = window.innerWidth;
        this.height = window.innerHeight;

        // Resize both canvases
        this.canvas2d.width = Math.max(1, this.width * this.quality);
        this.canvas2d.height = Math.max(1, this.height * this.quality);
        this.canvas2d.style.width = this.width + 'px';
        this.canvas2d.style.height = this.height + 'px';

        this.canvasWebGL.width = Math.max(1, this.width * this.quality);
        this.canvasWebGL.height = Math.max(1, this.height * this.quality);
        this.canvasWebGL.style.width = this.width + 'px';
        this.canvasWebGL.style.height = this.height + 'px';

        this.centerX = this.width * 0.5;
        this.centerY = this.height * 0.5;

        if (this.gl) {
            this.gl.viewport(0, 0, this.canvasWebGL.width, this.canvasWebGL.height);
        }

        if (this.ctx && this.canvas2d.width > 0 && this.canvas2d.height > 0) {
            this.imageData = this.ctx.createImageData(this.canvas2d.width, this.canvas2d.height);
            this.data32 = new Uint32Array(this.imageData.data.buffer);
        }
    }

    updateMetaballs(deltaTime) {
        const speedFactor = this.config.speed * 0.02;
        const dt = Math.min(deltaTime * 0.001, 0.1); // Cap delta time

        for (let i = 0; i < this.metaballs.length; i++) {
            const ball = this.metaballs[i];

            if (!ball.isDragging) {
                ball.angle += ball.orbitSpeed * speedFactor;

                // Use precalculated trig functions when possible
                const cos = Math.cos(ball.angle);
                const sin = Math.sin(ball.angle);

                const targetX = this.centerX + cos * ball.orbitRadius;
                const targetY = this.centerY + sin * ball.orbitRadius;

                // Smooth movement with delta time
                const smoothing = 1 - Math.exp(-5 * dt);
                ball.x += (targetX - ball.x) * smoothing;
                ball.y += (targetY - ball.y) * smoothing;

                // Simplified floating motion
                ball.x += Math.sin(ball.angle * 2) * 2;
                ball.y += Math.cos(ball.angle * 1.5) * 2;
            }
        }
    }

    renderWebGL() {
        const gl = this.gl;
        if (!gl || !this.program) return;

        gl.clearColor(0, 0, 0, 0.1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);

        // Update uniforms
        gl.uniform2f(this.uniforms.resolution, this.canvasWebGL.width, this.canvasWebGL.height);
        gl.uniform1f(this.uniforms.time, performance.now() * 0.001);
        gl.uniform1f(this.uniforms.threshold, this.config.threshold);
        gl.uniform1f(this.uniforms.glow, this.config.glow);

        // Update metaball positions and properties
        const positions = [];
        const colors = [];
        const radii = [];

        for (let i = 0; i < this.metaballs.length; i++) {
            const ball = this.metaballs[i];
            positions.push(ball.x * this.quality, (this.height - ball.y) * this.quality, 0);
            colors.push(...ball.color);
            radii.push(ball.radius * this.quality);
        }

        gl.uniform3fv(this.uniforms.balls, positions);
        gl.uniform3fv(this.uniforms.colors, colors);
        gl.uniform1fv(this.uniforms.radii, radii);

        // Draw
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // FIXED Canvas2D rendering with proper color blending
    renderCanvas2D() {
        const ctx = this.ctx;
        if (!ctx) return;

        const width = this.canvas2d.width;
        const height = this.canvas2d.height;
        const step = Math.max(1, this.config.resolution);
        const threshold = this.config.threshold * 0.003;
        const glowFactor = this.config.glow * 0.015;

        // Clear with fade effect
        ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
        ctx.fillRect(0, 0, width, height);

        // Pre-calculate metaball properties
        const balls = this.metaballs.map(ball => ({
            x: ball.x * this.quality,
            y: ball.y * this.quality,
            radius: ball.radius * this.quality,
            r: ball.color[0],
            g: ball.color[1],
            b: ball.color[2]
        }));

        // Render using field-based color blending
        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                let totalField = 0;
                let r = 0, g = 0, b = 0;

                // Calculate field strength with much slower falloff
                for (let i = 0; i < balls.length; i++) {
                    const dx = x - balls[i].x;
                    const dy = y - balls[i].y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    // Much slower falloff - extends 3x the radius
                    const normalizedDist = dist / (balls[i].radius * 3);
                    const field = Math.max(0, 1 - normalizedDist) ** 2;

                    // Accumulate color weighted by field
                    r += balls[i].r * field;
                    g += balls[i].g * field;
                    b += balls[i].b * field;
                    totalField += field;
                }

                // Check if field exceeds threshold
                if (totalField > threshold) {
                    // Normalize colors by total field
                    if (totalField > 0.001) {
                        r /= totalField;
                        g /= totalField;
                        b /= totalField;
                    }

                    // Very soft edge transition for smooth blending
                    const edge = this.smoothstep(0, threshold * 2, totalField);

                    // Calculate intensity
                    const intensity = edge * Math.min(1.5, Math.sqrt(totalField) * glowFactor);

                    ctx.fillStyle = `rgba(${(r * 255 * intensity) | 0}, ${(g * 255 * intensity) | 0}, ${(b * 255 * intensity) | 0}, ${Math.min(0.95, intensity)})`;
                    ctx.fillRect(x, y, step, step);
                }
            }
        }
    }

    // Helper function for smooth transitions
    smoothstep(edge0, edge1, x) {
        const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }

    updateFPS(currentTime) {
        this.frameCount++;

        if (currentTime - this.lastTime >= 1000) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastTime = currentTime;
            document.getElementById('fpsCounter').textContent = `FPS: ${this.fps}`;
        }
    }

    animate(currentTime = 0) {
        const deltaTime = currentTime - (this.previousTime || currentTime);
        this.previousTime = currentTime;

        this.updateFPS(currentTime);
        this.updateMetaballs(deltaTime);

        if (this.useWebGL && this.gl) {
            this.renderWebGL();
        } else if (this.ctx) {
            this.renderCanvas2D();
        }

        this.animationId = requestAnimationFrame(this.animate.bind(this));
    }
}

// Start the simulation
const metaballs = new OptimizedMetaballs();