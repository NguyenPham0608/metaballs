const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let width = window.innerWidth;
let height = window.innerHeight;
canvas.width = width;
canvas.height = height;

// Configuration
let config = {
    resolution: 8,
    threshold: 70,
    speed: 25,
    glow: 100,
    renderMode: 'smooth' // 'dots' or 'smooth'
};

// Metaballs
const metaballs = [
    {
        x: width * 0.5,
        y: height * 0.5,
        vx: 0,
        vy: 0,
        radius: 80,
        color: { r: 0, g: 255, b: 255 }, // Cyan
        angle: 0,
        orbitRadius: 150,
        orbitSpeed: 0.02
    },
    {
        x: width * 0.5,
        y: height * 0.5,
        vx: 0,
        vy: 0,
        radius: 100,
        color: { r: 255, g: 0, b: 255 }, // Magenta
        angle: Math.PI * 2 / 3,
        orbitRadius: 200,
        orbitSpeed: 0.015
    },
    {
        x: width * 0.5,
        y: height * 0.5,
        vx: 0,
        vy: 0,
        radius: 90,
        color: { r: 255, g: 255, b: 0 }, // Yellow
        angle: Math.PI * 4 / 3,
        orbitRadius: 120,
        orbitSpeed: 0.025
    }
];

// Mouse interaction
let mouse = { x: width / 2, y: height / 2, active: false };

canvas.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
});

canvas.addEventListener('mouseleave', () => {
    mouse.active = false;
});

// Controls
document.getElementById('resolution').addEventListener('input', (e) => {
    config.resolution = parseInt(e.target.value);
    document.getElementById('resValue').textContent = e.target.value;
});

document.getElementById('threshold').addEventListener('input', (e) => {
    config.threshold = parseInt(e.target.value);
    document.getElementById('thresholdValue').textContent = e.target.value;
});

document.getElementById('speed').addEventListener('input', (e) => {
    config.speed = parseInt(e.target.value);
    document.getElementById('speedValue').textContent = e.target.value;
});

document.getElementById('glow').addEventListener('input', (e) => {
    config.glow = parseInt(e.target.value);
    document.getElementById('glowValue').textContent = e.target.value;
});

document.getElementById('toggleMode').addEventListener('click', () => {
    config.renderMode = config.renderMode === 'dots' ? 'smooth' : 'dots';
});

// Resize handler
window.addEventListener('resize', () => {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
});

// Animation loop
function animate() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fillRect(0, 0, width, height);

    // Update metaball positions
    const centerX = width / 2;
    const centerY = height / 2;
    const speedFactor = config.speed / 50;

    metaballs.forEach((ball, i) => {
        ball.angle += ball.orbitSpeed * speedFactor;

        // Orbital motion
        let targetX = centerX + Math.cos(ball.angle) * ball.orbitRadius;
        let targetY = centerY + Math.sin(ball.angle) * ball.orbitRadius;

        // Smooth movement
        ball.x += (targetX - ball.x) * 0.1;
        ball.y += (targetY - ball.y) * 0.1;

        // Add some floating motion
        ball.x += Math.sin(ball.angle * 2) * 2;
        ball.y += Math.cos(ball.angle * 1.5) * 2;
    });

    // Render metaballs
    if (config.renderMode === 'dots') {
        renderDots();
    } else {
        renderSmooth();
    }

    requestAnimationFrame(animate);
}

function renderDots() {
    const res = config.resolution;
    const threshold = config.threshold;
    const glowFactor = config.glow / 100;

    for (let x = 0; x < width; x += res) {
        for (let y = 0; y < height; y += res) {
            let sumR = 0, sumG = 0, sumB = 0;
            let influence = 0;

            metaballs.forEach(ball => {
                const dist = Math.hypot(x - ball.x, y - ball.y);
                const inf = Math.max(0, ball.radius * ball.radius / (dist * dist + 1));

                influence += inf;
                sumR += ball.color.r * inf;
                sumG += ball.color.g * inf;
                sumB += ball.color.b * inf;
            });

            if (influence > threshold / 100) {
                const intensity = Math.min(1, influence * glowFactor / 3);
                const r = Math.min(255, sumR / influence * intensity);
                const g = Math.min(255, sumG / influence * intensity);
                const b = Math.min(255, sumB / influence * intensity);

                // Create glow effect
                const glowSize = res * (0.5 + intensity * 0.5);
                const gradient = ctx.createRadialGradient(x, y, 0, x, y, glowSize);
                gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${intensity})`);
                gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

                ctx.fillStyle = gradient;
                ctx.fillRect(x - glowSize, y - glowSize, glowSize * 2, glowSize * 2);

                // Core dot
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${intensity * 0.8})`;
                ctx.fillRect(x - res / 4, y - res / 4, res / 2, res / 2);
            }
        }
    }
}

function renderSmooth() {
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    const threshold = config.threshold;
    const glowFactor = config.glow / 100;
    const step = Math.max(1, Math.floor(config.resolution / 2));

    for (let x = 0; x < width; x += step) {
        for (let y = 0; y < height; y += step) {
            let sumR = 0, sumG = 0, sumB = 0;
            let influence = 0;

            metaballs.forEach(ball => {
                const dist = Math.hypot(x - ball.x, y - ball.y);
                const inf = Math.max(0, ball.radius * ball.radius / (dist * dist + 1));

                influence += inf;
                sumR += ball.color.r * inf;
                sumG += ball.color.g * inf;
                sumB += ball.color.b * inf;
            });

            if (influence > threshold / 100) {
                const intensity = Math.min(1, influence * glowFactor / 3);
                const r = Math.min(255, sumR / influence * intensity);
                const g = Math.min(255, sumG / influence * intensity);
                const b = Math.min(255, sumB / influence * intensity);

                // Fill pixels
                for (let dx = 0; dx < step; dx++) {
                    for (let dy = 0; dy < step; dy++) {
                        const px = x + dx;
                        const py = y + dy;
                        if (px < width && py < height) {
                            const index = (py * width + px) * 4;
                            data[index] = r;
                            data[index + 1] = g;
                            data[index + 2] = b;
                            data[index + 3] = intensity * 255;
                        }
                    }
                }
            }
        }
    }

    ctx.putImageData(imageData, 0, 0);
}

// Start animation
animate();