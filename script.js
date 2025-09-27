// WebGL vertex shader
const vertexShaderSource = `
attribute vec2 a_position;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_balls[10];
uniform vec3 u_colors[10];
uniform float u_radii[10];
uniform int u_ballCount;
uniform float u_threshold;
uniform float u_glow;

float fieldFalloff(float dist, float radius) {
    float normalizedDist = dist / (radius * 3.0);
    return pow(max(0.0, 1.0 - normalizedDist), 2.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy;
    float totalField = 0.0;
    vec3 weightedColor = vec3(0.0);

    for (int i = 0; i < 10; i++) {
        if (i >= u_ballCount) break;
        
        vec2 ballPos = u_balls[i].xy;
        float radius = u_radii[i];
        float dist = distance(uv, ballPos);
        float field = fieldFalloff(dist, radius);
        
        totalField += field;
        weightedColor += u_colors[i] * field;
    }

    if (totalField > u_threshold * 0.003) {
        vec3 mixedColor = weightedColor / totalField;
        
        float core = smoothstep(u_threshold * 0.003, u_threshold * 0.005, totalField);
        float halo = smoothstep(u_threshold * 0.0005, u_threshold * 0.04, totalField);
        
        float brightness = pow(totalField, 0.4);
        float alpha = (core * u_glow * 0.03 * brightness) + (halo * 0.3 * brightness);
        
        gl_FragColor = vec4(mixedColor, min(0.99, alpha));
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
        // Add these properties after existing config
        this.maxBalls = 20;
        this.effects = {
            colorCycling: false,
            gravity: false,
            collision: false,
            mouseAttraction: false,
            mouseRepulsion: false,
            pulsing: false,
            chromatic: false,
            rainbow: false,
            clickSpawn: false
        };

        // Modify existing metaballs to add physics properties
        this.metaballs = this.metaballs.map(ball => ({
            ...ball,
            vx: 0,
            vy: 0,
            mass: ball.radius,
            hue: ball === this.metaballs[0] ? 180 : ball === this.metaballs[1] ? 300 : 60
        }));
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
        // Replace the entire this.uniforms = {...} with:
        // Add ballCount uniform to the existing uniforms
        this.uniforms = {
            resolution: gl.getUniformLocation(this.program, 'u_resolution'),
            time: gl.getUniformLocation(this.program, 'u_time'),
            balls: gl.getUniformLocation(this.program, 'u_balls'),
            colors: gl.getUniformLocation(this.program, 'u_colors'),
            radii: gl.getUniformLocation(this.program, 'u_radii'),
            ballCount: gl.getUniformLocation(this.program, 'u_ballCount'), // Add this line
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

    // Add HSL to RGB converter
    hslToRgb(h, s, l) {
        let r, g, b;
        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }
        return [r, g, b];
    }

    // Gravity physics
    applyGravity() {
        const G = 0.3;
        for (let i = 0; i < this.metaballs.length; i++) {
            for (let j = i + 1; j < this.metaballs.length; j++) {
                const ball1 = this.metaballs[i];
                const ball2 = this.metaballs[j];

                const dx = ball2.x - ball1.x;
                const dy = ball2.y - ball1.y;
                const distSq = dx * dx + dy * dy;
                const dist = Math.sqrt(distSq);

                if (dist > 10 && dist < 500) {
                    const force = G * (ball1.mass * ball2.mass) / distSq;
                    const fx = force * dx / dist;
                    const fy = force * dy / dist;

                    ball1.vx += fx / ball1.mass;
                    ball1.vy += fy / ball1.mass;
                    ball2.vx -= fx / ball2.mass;
                    ball2.vy -= fy / ball2.mass;
                }
            }
        }
    }

    // Collision detection
    handleCollisions() {
        for (let i = 0; i < this.metaballs.length; i++) {
            for (let j = i + 1; j < this.metaballs.length; j++) {
                const ball1 = this.metaballs[i];
                const ball2 = this.metaballs[j];

                const dx = ball2.x - ball1.x;
                const dy = ball2.y - ball1.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const minDist = (ball1.radius + ball2.radius) * 0.8;

                if (dist < minDist && dist > 0) {
                    const nx = dx / dist;
                    const ny = dy / dist;

                    const dvx = ball2.vx - ball1.vx;
                    const dvy = ball2.vy - ball1.vy;
                    const dot = dvx * nx + dvy * ny;

                    if (dot > 0) continue;

                    const mass1 = ball1.mass;
                    const mass2 = ball2.mass;
                    const impulse = 2 * dot / (mass1 + mass2);

                    ball1.vx += impulse * mass2 * nx;
                    ball1.vy += impulse * mass2 * ny;
                    ball2.vx -= impulse * mass1 * nx;
                    ball2.vy -= impulse * mass1 * ny;

                    const overlap = minDist - dist;
                    const separationX = nx * overlap * 0.5;
                    const separationY = ny * overlap * 0.5;
                    ball1.x -= separationX;
                    ball1.y -= separationY;
                    ball2.x += separationX;
                    ball2.y += separationY;
                }
            }
        }
    }

    // Mouse forces
    applyMouseForce() {
        const force = this.config.mouseForce * 0.01;
        const direction = this.effects.mouseRepulsion ? -1 : 1;

        this.metaballs.forEach(ball => {
            if (!ball.isDragging) {
                const dx = this.mouse.x - ball.x;
                const dy = this.mouse.y - ball.y;
                const distSq = dx * dx + dy * dy;
                const dist = Math.sqrt(distSq);

                if (dist > 1 && dist < 400) {
                    const f = force * direction / dist;
                    ball.vx += dx * f;
                    ball.vy += dy * f;
                }
            }
        });
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
        document.addEventListener('keydown', (e) => {
            if (e.key === 's') {
                this.takeScreenshot();
            }
        });

        // Add these at the end of setupEventListeners method:

        // Add mouse force control
        document.getElementById('mouseForce').addEventListener('input', (e) => {
            this.config.mouseForce = parseInt(e.target.value);
            document.getElementById('mouseForceValue').textContent = e.target.value;
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            switch (e.key) {
                case '1':
                    this.effects.colorCycling = !this.effects.colorCycling;
                    document.getElementById('colorCycleBtn')?.classList.toggle('active');
                    break;
                case '2':
                    this.effects.gravity = !this.effects.gravity;
                    document.getElementById('gravityBtn')?.classList.toggle('active');
                    break;
                case '3':
                    this.effects.collision = !this.effects.collision;
                    document.getElementById('collisionBtn')?.classList.toggle('active');
                    break;
                case '4':
                    this.effects.mouseAttraction = !this.effects.mouseAttraction;
                    this.effects.mouseRepulsion = false;
                    document.getElementById('mouseAttractBtn')?.classList.toggle('active');
                    if (this.effects.mouseAttraction) {
                        document.getElementById('mouseRepelBtn')?.classList.remove('active');
                    }
                    break;
                case '5':
                    this.effects.mouseRepulsion = !this.effects.mouseRepulsion;
                    this.effects.mouseAttraction = false;
                    document.getElementById('mouseRepelBtn')?.classList.toggle('active');
                    if (this.effects.mouseRepulsion) {
                        document.getElementById('mouseAttractBtn')?.classList.remove('active');
                    }
                    break;
                case '6':
                    this.effects.pulsing = !this.effects.pulsing;
                    document.getElementById('pulsingBtn')?.classList.toggle('active');
                    break;
                case '7':
                    this.effects.chromatic = !this.effects.chromatic;
                    document.getElementById('chromaticBtn')?.classList.toggle('active');
                    break;
                case '8':
                    this.effects.rainbow = !this.effects.rainbow;
                    document.getElementById('rainbowBtn')?.classList.toggle('active');
                    break;
                case 'c':
                case 'C':
                    this.effects.clickSpawn = !this.effects.clickSpawn;
                    document.getElementById('clickSpawnBtn')?.classList.toggle('active');
                    break;
                case 's':
                    this.takeScreenshot();
                    break;
            }
        });

        // Click to spawn
        this.canvasWebGL.addEventListener('click', (e) => {
            if (this.effects.clickSpawn && !this.mouse.isDragging && this.metaballs.length < 10) {
                const newBall = {
                    x: e.clientX,
                    y: e.clientY,
                    vx: (Math.random() - 0.5) * 10,
                    vy: (Math.random() - 0.5) * 10,
                    radius: 80,
                    mass: 80,
                    color: this.hslToRgb(Math.random(), 1, 0.5),
                    hue: Math.random() * 360,
                    angle: 0,
                    orbitRadius: 100,
                    orbitSpeed: 0.01 + Math.random() * 0.02,
                    isDragging: false
                };
                this.metaballs.push(newBall);

                // Update FPS counter
                document.getElementById('fpsCounter').textContent = `FPS: ${this.fps} | Balls: ${this.metaballs.length}`;
            }
        });

        // Effect buttons
        const effectButtons = [
            { id: 'colorCycleBtn', effect: 'colorCycling' },
            { id: 'gravityBtn', effect: 'gravity' },
            { id: 'collisionBtn', effect: 'collision' },
            { id: 'mouseAttractBtn', effect: 'mouseAttraction' },
            { id: 'mouseRepelBtn', effect: 'mouseRepulsion' },
            { id: 'pulsingBtn', effect: 'pulsing' },
            { id: 'chromaticBtn', effect: 'chromatic' },
            { id: 'rainbowBtn', effect: 'rainbow' },
            { id: 'clickSpawnBtn', effect: 'clickSpawn' }
        ];

        effectButtons.forEach(btn => {
            const element = document.getElementById(btn.id);
            if (element) {
                element.addEventListener('click', () => {
                    if (btn.effect === 'mouseAttraction' && !this.effects.mouseAttraction) {
                        this.effects.mouseRepulsion = false;
                        document.getElementById('mouseRepelBtn')?.classList.remove('active');
                    } else if (btn.effect === 'mouseRepulsion' && !this.effects.mouseRepulsion) {
                        this.effects.mouseAttraction = false;
                        document.getElementById('mouseAttractBtn')?.classList.remove('active');
                    }

                    this.effects[btn.effect] = !this.effects[btn.effect];
                    element.classList.toggle('active');
                });
            }
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

    // Replace the handleMouseUp method with this updated version:

    handleMouseUp() {
        if (this.mouse.draggedBall) {
            const ball = this.mouse.draggedBall;

            // Calculate new orbit parameters based on dropped position
            const dx = ball.x - this.centerX;
            const dy = ball.y - this.centerY;
            ball.orbitRadius = Math.sqrt(dx * dx + dy * dy);
            ball.angle = Math.atan2(dy, dx);

            ball.isDragging = false;
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
    takeScreenshot() {
        if (this.useWebGL && this.gl) {
            // WebGL screenshot
            const gl = this.gl;
            const canvas = this.canvasWebGL;

            // Re-render one frame with transparent background
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            // Render the metaballs
            this.renderWebGL();

            // Capture and download
            canvas.toBlob((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `metaballs_${Date.now()}.png`;
                a.click();
                URL.revokeObjectURL(url);
            });
        } else {
            // Canvas2D screenshot (original code)
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas2d.width;
            tempCanvas.height = this.canvas2d.height;
            const tempCtx = tempCanvas.getContext('2d');

            // Render only metaballs with no background
            const width = tempCanvas.width;
            const height = tempCanvas.height;
            const step = Math.max(1, this.config.resolution);
            const threshold = this.config.threshold * 0.003;
            const glowFactor = this.config.glow * 0.015;

            const balls = this.metaballs.map(ball => ({
                x: ball.x * this.quality,
                y: ball.y * this.quality,
                radius: ball.radius * this.quality,
                r: ball.color[0],
                g: ball.color[1],
                b: ball.color[2]
            }));

            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    let totalField = 0;
                    let r = 0, g = 0, b = 0;

                    for (let i = 0; i < balls.length; i++) {
                        const dx = x - balls[i].x;
                        const dy = y - balls[i].y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        const normalizedDist = dist / (balls[i].radius * 3);
                        const field = Math.max(0, 1 - normalizedDist) ** 2;

                        r += balls[i].r * field;
                        g += balls[i].g * field;
                        b += balls[i].b * field;
                        totalField += field;
                    }

                    if (totalField > threshold) {
                        r /= totalField;
                        g /= totalField;
                        b /= totalField;

                        const edge = this.smoothstep(0, threshold * 2, totalField);
                        const intensity = edge * Math.min(1.5, Math.sqrt(totalField) * glowFactor);

                        tempCtx.fillStyle = `rgba(${(r * 255 * intensity) | 0}, ${(g * 255 * intensity) | 0}, ${(b * 255 * intensity) | 0}, ${Math.min(0.95, intensity)})`;
                        tempCtx.fillRect(x, y, step, step);
                    }
                }
            }

            // Download the image
            tempCanvas.toBlob((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `metaballs_${Date.now()}.png`;
                a.click();
                URL.revokeObjectURL(url);
            });
        }
    }


    updateMetaballs(deltaTime) {
        const speedFactor = this.config.speed * 0.02;
        const dt = Math.min(deltaTime * 0.001, 0.1);

        // Apply physics
        if (this.effects.gravity) this.applyGravity();
        if (this.effects.collision) this.handleCollisions();
        if (this.effects.mouseAttraction || this.effects.mouseRepulsion) {
            this.applyMouseForce();
        }

        for (let i = 0; i < this.metaballs.length; i++) {
            const ball = this.metaballs[i];

            if (!ball.isDragging) {
                if (this.effects.gravity || this.effects.mouseAttraction || this.effects.mouseRepulsion) {
                    ball.x += ball.vx * dt * 60;
                    ball.y += ball.vy * dt * 60;
                    ball.vx *= 0.99;
                    ball.vy *= 0.99;

                    if (ball.x < ball.radius || ball.x > this.width - ball.radius) {
                        ball.vx *= -0.7;
                        ball.x = Math.max(ball.radius, Math.min(this.width - ball.radius, ball.x));
                    }
                    if (ball.y < ball.radius || ball.y > this.height - ball.radius) {
                        ball.vy *= -0.7;
                        ball.y = Math.max(ball.radius, Math.min(this.height - ball.radius, ball.y));
                    }
                } else {
                    ball.angle += ball.orbitSpeed * speedFactor;
                    const targetX = this.centerX + Math.cos(ball.angle) * ball.orbitRadius;
                    const targetY = this.centerY + Math.sin(ball.angle) * ball.orbitRadius;

                    const smoothing = 1 - Math.exp(-5 * dt);
                    ball.x += (targetX - ball.x) * smoothing;
                    ball.y += (targetY - ball.y) * smoothing;

                    ball.x += Math.sin(ball.angle * 2) * 2;
                    ball.y += Math.cos(ball.angle * 1.5) * 2;
                }
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
        gl.uniform1i(this.uniforms.ballCount, this.metaballs.length); // Add this line

        // Update metaball positions and properties (support up to 10)
        const positions = [];
        const colors = [];
        const radii = [];

        for (let i = 0; i < Math.min(this.metaballs.length, this.maxBalls); i++) {
            const ball = this.metaballs[i];
            positions.push(ball.x * this.quality, (this.height - ball.y) * this.quality, 0);
            colors.push(...ball.color);
            radii.push(ball.radius * this.quality);
        }

        // Pad arrays for unused slots
        for (let i = this.metaballs.length; i < this.maxBalls; i++) {
            positions.push(0, 0, 0);
            colors.push(0, 0, 0);
            radii.push(0);
        }

        gl.uniform3fv(this.uniforms.balls, positions);
        gl.uniform3fv(this.uniforms.colors, colors);
        gl.uniform1fv(this.uniforms.radii, radii);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
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
            document.getElementById('fpsCounter').textContent = `FPS: ${this.fps} | Balls: ${this.metaballs.length}`;
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