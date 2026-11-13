/* ==========================================================================
   effects.js — визуальные эффекты для сайта-открытки ко Дню Рождения
   Тема «ночное небо»: тёмно-синий фон, золотые и розовые акценты.

   Обычный классический скрипт (НЕ ES-модуль), без зависимостей,
   работает по file://. Подключать так:

     <script src="assets/effects.js"></script>

   Публичный API (window.Effects):

     Effects.initStarfield()
       Звёздное небо на весь экран (fixed canvas, z-index: -1):
       мерцающие звёзды, дрейфующая золотая пыль и падающие звёзды
       с хвостом (примерно раз в 4–9 секунд).

     Effects.heartBurst(x, y, count)
       Взрыв сердечек из точки (x, y) в координатах viewport.
       count — от 10 до 60 (значения за пределами обрезаются).

     Effects.sparkleTrail()
       Золотые искорки-звёздочки за курсором мыши.
       На тач-устройствах не активируется.

   Все методы безопасны: при отсутствии canvas, requestAnimationFrame
   или включённом prefers-reduced-motion они тихо превращаются в no-op
   и никогда не бросают исключений наружу. initStarfield и sparkleTrail
   идемпотентны, heartBurst не накапливает мусор (жёсткий потолок частиц).
   ========================================================================== */

window.Effects = (function () {
  'use strict';

  /* ============ 1. Проверки поддержки и базовые утилиты ================== */

  // requestAnimationFrame — сердце всех анимаций; нет его — нет эффектов
  var raf = (typeof window.requestAnimationFrame === 'function')
    ? window.requestAnimationFrame.bind(window)
    : null;
  var caf = (typeof window.cancelAnimationFrame === 'function')
    ? window.cancelAnimationFrame.bind(window)
    : null;

  // Canvas должен уметь 2d-контекст
  var supportsCanvas = (function () {
    try {
      var probe = document.createElement('canvas');
      return !!(probe && typeof probe.getContext === 'function' && probe.getContext('2d'));
    } catch (err) {
      return false;
    }
  })();

  // Итоговая «разрешённость» эффектов: нужны и canvas, и rAF
  var supported = supportsCanvas && !!raf && !!caf;

  // prefers-reduced-motion: уважаем настройку пользователя
  var mqReduce = null;
  try {
    if (typeof window.matchMedia === 'function') {
      mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    }
  } catch (err) {
    mqReduce = null;
  }

  function reducedMotion() {
    try {
      return !!(mqReduce && mqReduce.matches);
    } catch (err) {
      return false;
    }
  }

  // Текущее время в мс (совпадает с таймштампами rAF, где они есть)
  function nowMs() {
    return (window.performance && typeof window.performance.now === 'function')
      ? window.performance.now()
      : Date.now();
  }

  // Случайное число в диапазоне [min, max)
  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  // Случайный элемент массива
  function pick(arr) {
    return arr[(Math.random() * arr.length) | 0];
  }

  // Ограничиваем devicePixelRatio двойкой, чтобы 4K-экраны не убивали FPS
  function pixelRatio() {
    var ratio = window.devicePixelRatio || 1;
    if (!isFinite(ratio) || ratio <= 0) ratio = 1;
    return Math.min(ratio, 2);
  }

  // canvas с фиксированным позиционированием на весь экран
  function makeCanvas(zIndex) {
    var canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.zIndex = String(zIndex);
    canvas.style.pointerEvents = 'none'; // никогда не перехватываем клики
    return canvas;
  }

  // Подгоняем canvas под окно с учётом DPR, возвращаем 2d-контекст.
  // Дальше рисуем в обычных CSS-пикселях: система координат масштабируется.
  function fitCanvas(canvas) {
    var ratio = pixelRatio();
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * ratio));
    canvas.height = Math.max(1, Math.round(h * ratio));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return ctx;
  }

  // dt в секундах между кадрами, с защитой от скачков (сон вкладки и т.п.)
  function frameDelta(now, last) {
    var dt = (now - last) / 1000;
    if (!isFinite(dt) || dt <= 0) dt = 0.016;
    if (dt > 0.05) dt = 0.05;
    return dt;
  }

  // Если <body> ещё не появился (скрипт в <head>) — ждём DOMContentLoaded
  function whenBodyReady(fn) {
    if (document.body) {
      fn();
      return;
    }
    try {
      document.addEventListener('DOMContentLoaded', function handler() {
        document.removeEventListener('DOMContentLoaded', handler);
        fn();
      });
    } catch (err) {
      /* очень старый браузер — тихо сдаёмся */
    }
  }

  /* ---------- Единый обработчик resize для всех активных canvas'ов ------- */

  var resizers = [];
  var resizeListenerAttached = false;
  var resizeScheduled = false;

  function handleResize() {
    if (resizeScheduled) return;
    resizeScheduled = true;
    raf(function () {
      resizeScheduled = false;
      for (var i = 0; i < resizers.length; i++) {
        try { resizers[i](); } catch (err) { /* тишина */ }
      }
    });
  }

  function addResizer(fn) {
    resizers.push(fn);
    if (!resizeListenerAttached) {
      window.addEventListener('resize', handleResize);
      resizeListenerAttached = true;
    }
  }

  /* --------------- Мягкое светящееся пятно (готовый спрайт) -------------- */
  /* Готовим один раз на маленьком offscreen-canvas и дальше быстро
     штампуем через drawImage — пыль и головки падающих звёзд получаются
     «дымчатыми» без дорогого shadowBlur на каждый кадр. */

  var glowSprite = null;

  function getGlowSprite() {
    if (glowSprite) return glowSprite;
    try {
      var size = 64;
      var off = document.createElement('canvas');
      off.width = size;
      off.height = size;
      var g = off.getContext('2d');
      var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255, 224, 168, 0.9)');
      grad.addColorStop(0.35, 'rgba(255, 206, 130, 0.35)');
      grad.addColorStop(1, 'rgba(255, 206, 130, 0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      glowSprite = off;
    } catch (err) {
      glowSprite = null; // рисуем тогда просто кружками
    }
    return glowSprite;
  }

  /* ========================= 2. Звёздное небо ============================ */

  var starCanvas = null;
  var starCtx = null;
  var stars = [];
  var dust = [];
  var shooting = null;          // текущая падающая звезда (или null)
  var nextShootingAt = 0;       // время следующей падающей звезды
  var starRafId = 0;
  var lastSkyTime = 0;

  // Заново раскладываем звёзды и пыль (при старте и после resize)
  function buildSky(w, h) {
    stars = [];
    dust = [];
    var area = w * h;

    var starCount = Math.round(area / 8000);
    if (starCount < 60) starCount = 60;
    if (starCount > 240) starCount = 240;

    var dustCount = Math.round(area / 30000);
    if (dustCount < 14) dustCount = 14;
    if (dustCount > 60) dustCount = 60;

    for (var i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        // основная масса — крошечные, изредка — покрупнее
        r: rand(0.4, 1.6) + (Math.random() < 0.08 ? rand(0.7, 1.4) : 0),
        base: rand(0.35, 0.95),             // базовая яркость
        twinkle: rand(0.5, 1.8),            // скорость мерцания
        phase: Math.random() * Math.PI * 2, // фаза мерцания
        gold: Math.random() < 0.38,         // часть звёзд — золотистые
        driftX: rand(-1.6, 1.6),            // едва заметный дрейф
        driftY: rand(-1.0, 1.0)
      });
    }

    for (var j = 0; j < dustCount; j++) {
      dust.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: rand(1.5, 4.5),                  // радиус ядра пылинки
        alpha: rand(0.10, 0.38),
        vx: rand(-9, 9),                    // медленный дрейф
        vy: rand(-6, 6),
        sway: Math.random() * Math.PI * 2,  // фаза покачивания
        swaySpeed: rand(0.15, 0.5)
      });
    }
  }

  // Запуск новой падающей звезды
  function spawnShooting(w, h, now) {
    var dir = Math.random() < 0.5 ? -1 : 1;
    var angle = rand(0.35, 0.75);   // наклон вниз от горизонта, радианы
    var speed = rand(420, 760);
    shooting = {
      x: rand(w * 0.1, w * 0.9),
      y: rand(-20, h * 0.35),
      vx: Math.cos(angle) * speed * dir,
      vy: Math.sin(angle) * speed,
      tail: rand(110, 220),         // длина хвоста
      life: rand(0.7, 1.2),
      maxLife: 0
    };
    shooting.maxLife = shooting.life;
    // следующая падающая звезда — через 4–9 секунд
    nextShootingAt = now + rand(4000, 9000);
  }

  // Отрисовка падающей звезды: хвост-градиент + светящаяся головка
  function drawShooting() {
    var s = shooting;
    var len = Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1;
    var nx = s.vx / len;
    var ny = s.vy / len;
    // мягкое появление в начале и затухание в конце полёта
    var fadeIn = Math.min(1, (s.maxLife - s.life) / 0.12);
    var fadeOut = Math.min(1, s.life / 0.3);
    var alpha = fadeIn * fadeOut;
    if (alpha <= 0) return;

    var grad = starCtx.createLinearGradient(s.x, s.y, s.x - nx * s.tail, s.y - ny * s.tail);
    grad.addColorStop(0, 'rgba(255, 243, 210, ' + (0.95 * alpha).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(255, 210, 130, 0)');
    starCtx.strokeStyle = grad;
    starCtx.lineWidth = 2;
    starCtx.lineCap = 'round';
    starCtx.beginPath();
    starCtx.moveTo(s.x, s.y);
    starCtx.lineTo(s.x - nx * s.tail, s.y - ny * s.tail);
    starCtx.stroke();

    var sprite = getGlowSprite();
    if (sprite) {
      starCtx.globalAlpha = alpha;
      starCtx.drawImage(sprite, s.x - 16, s.y - 16, 32, 32);
      starCtx.globalAlpha = 1;
    }
  }

  // Основной цикл неба
  function drawSky(now) {
    if (!starCtx) return; // небо успели убрать — не перепланируем кадры
    var dt = frameDelta(now, lastSkyTime);
    lastSkyTime = now;

    var w = window.innerWidth;
    var h = window.innerHeight;
    starCtx.clearRect(0, 0, w, h);

    var i;
    var s;

    // Мерцающие звёзды
    for (i = 0; i < stars.length; i++) {
      s = stars[i];
      s.x += s.driftX * dt;
      s.y += s.driftY * dt;
      // заворачиваем звёзды по краям экрана
      if (s.x < -2) s.x = w + 2; else if (s.x > w + 2) s.x = -2;
      if (s.y < -2) s.y = h + 2; else if (s.y > h + 2) s.y = -2;
      var tw = 0.55 + 0.45 * Math.sin(now / 1000 * s.twinkle + s.phase);
      starCtx.globalAlpha = s.base * tw;
      starCtx.fillStyle = s.gold ? '#ffd98a' : '#ffffff';
      starCtx.beginPath();
      starCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      starCtx.fill();
    }

    // Медленно дрейфующая золотая пыль (мягкие пятна через спрайт)
    var sprite = getGlowSprite();
    for (i = 0; i < dust.length; i++) {
      var d = dust[i];
      d.sway += d.swaySpeed * dt;
      d.x += (d.vx + Math.sin(d.sway) * 6) * dt;
      d.y += d.vy * dt;
      if (d.x < -12) d.x = w + 12; else if (d.x > w + 12) d.x = -12;
      if (d.y < -12) d.y = h + 12; else if (d.y > h + 12) d.y = -12;
      starCtx.globalAlpha = d.alpha * (0.7 + 0.3 * Math.sin(d.sway * 1.7));
      if (sprite) {
        var rr = d.r * 4;
        starCtx.drawImage(sprite, d.x - rr, d.y - rr, rr * 2, rr * 2);
      } else {
        starCtx.fillStyle = '#ffce82';
        starCtx.beginPath();
        starCtx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        starCtx.fill();
      }
    }
    starCtx.globalAlpha = 1;

    // Падающая звезда: ждём своего часа, летим, гаснем
    if (!shooting && now >= nextShootingAt) {
      spawnShooting(w, h, now);
    }
    if (shooting) {
      shooting.life -= dt;
      shooting.x += shooting.vx * dt;
      shooting.y += shooting.vy * dt;
      drawShooting();
      var gone = shooting.life <= 0 ||
        shooting.x < -shooting.tail - 40 || shooting.x > w + shooting.tail + 40 ||
        shooting.y > h + shooting.tail + 40;
      if (gone) shooting = null;
    }

    starRafId = raf(drawSky);
  }

  function initStarfield() {
    if (!supported || reducedMotion()) return;
    if (starCanvas) return; // идемпотентность: небо уже развешено

    whenBodyReady(function () {
      if (starCanvas || !supported || reducedMotion()) return;
      try {
        starCanvas = makeCanvas(-1);
        document.body.appendChild(starCanvas);
        starCtx = fitCanvas(starCanvas);
        buildSky(window.innerWidth, window.innerHeight);
        addResizer(function () {
          if (!starCanvas) return;
          starCtx = fitCanvas(starCanvas);
          buildSky(window.innerWidth, window.innerHeight);
        });
        lastSkyTime = nowMs();
        nextShootingAt = nowMs() + rand(4000, 9000);
        starRafId = raf(drawSky);
      } catch (err) {
        // тихо деградируем: убираем недоделанный canvas
        if (starCanvas && starCanvas.parentNode) {
          starCanvas.parentNode.removeChild(starCanvas);
        }
        starCanvas = null;
        starCtx = null;
      }
    });
  }

  /* ======================= 3. Взрыв сердечек ============================= */

  var burstCanvas = null;
  var burstCtx = null;
  var hearts = [];
  var burstRafId = 0;
  var burstRunning = false;
  var lastBurstTime = 0;

  var MAX_HEARTS = 300; // жёсткий потолок частиц: частые вызовы не течь памятью
  var HEART_COLORS = ['#ff9ebb', '#ffd98a', '#f5d76e']; // розовый -> золотой

  // Классическое сердечко двумя кривыми Безье; центр в точке (0, 0)
  function heartPath(ctx, s) {
    ctx.beginPath();
    ctx.moveTo(0, s * 0.9); // нижний кончик
    ctx.bezierCurveTo(-s * 1.1, s * 0.1, -s * 0.95, -s * 0.9, 0, -s * 0.35); // левая доля
    ctx.bezierCurveTo(s * 0.95, -s * 0.9, s * 1.1, s * 0.1, 0, s * 0.9);     // правая доля
    ctx.closePath();
  }

  // Один общий canvas на все взрывы (переиспользуем, не создаём новых)
  function ensureBurstCanvas() {
    if (burstCanvas) {
      if (!burstCtx) burstCtx = fitCanvas(burstCanvas);
      return;
    }
    burstCanvas = makeCanvas(9999); // сердечки рисуем поверх контента
    document.body.appendChild(burstCanvas);
    burstCtx = fitCanvas(burstCanvas);
    addResizer(function () {
      if (burstCanvas) burstCtx = fitCanvas(burstCanvas);
    });
  }

  function startBurstLoop() {
    if (burstRunning) return; // цикл уже крутится — новые сердечки просто войдут в него
    burstRunning = true;
    lastBurstTime = nowMs();
    burstRafId = raf(drawHearts);
  }

  function drawHearts(now) {
    if (!burstCtx) { // canvas успели убрать (например, включился reduced-motion)
      hearts = [];
      burstRunning = false;
      return;
    }
    var dt = frameDelta(now, lastBurstTime);
    lastBurstTime = now;

    var w = window.innerWidth;
    var h = window.innerHeight;
    burstCtx.clearRect(0, 0, w, h);

    // идём с конца массива, чтобы спокойно удалять отжившие сердечки
    for (var i = hearts.length - 1; i >= 0; i--) {
      var p = hearts[i];
      p.age += dt;
      if (p.age >= p.life) {
        hearts.splice(i, 1); // самоочистка: частица покидает массив и память
        continue;
      }
      p.vy += 300 * dt;               // лёгкая гравитация
      p.vx *= Math.exp(-0.5 * dt);    // лёгкое сопротивление воздуха
      p.vy *= Math.exp(-0.15 * dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;

      var t = p.age / p.life;                            // прогресс жизни 0..1
      var alpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;  // затухание в конце
      var scale = 0.5 + 0.5 * Math.min(1, p.age / 0.12); // быстрый «выстрел» размера
      scale *= 1 - 0.25 * t;                             // слегка съёживается

      burstCtx.save();
      burstCtx.translate(p.x, p.y);
      burstCtx.rotate(p.rot);
      burstCtx.scale(scale, scale);
      burstCtx.globalAlpha = Math.max(0, alpha);
      burstCtx.fillStyle = p.color;
      heartPath(burstCtx, p.size);
      burstCtx.fill();
      burstCtx.restore();
    }

    if (hearts.length > 0) {
      burstRafId = raf(drawHearts);
    } else {
      burstCtx.clearRect(0, 0, w, h); // финальная уборка: canvas пуст
      burstRunning = false;           // rAF-цикл останавливается до следующего вызова
    }
  }

  function doHeartBurst(x, y, count) {
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return;

    // договорённость API: count в диапазоне 10–60
    count = Math.round(count);
    if (!isFinite(count)) count = 10;
    if (count < 10) count = 10;
    if (count > 60) count = 60;

    ensureBurstCanvas();
    if (!burstCtx) return;

    // не даём превысить общий потолок частиц, сколько бы нас ни звали
    var free = MAX_HEARTS - hearts.length;
    if (free <= 0) return;
    if (count > free) count = free;

    for (var i = 0; i < count; i++) {
      var angle = rand(0, Math.PI * 2);
      var speed = rand(120, 430);
      hearts.push({
        x: x + rand(-6, 6),
        y: y + rand(-6, 6),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - rand(30, 120), // небольшой сдвиг вверх
        rot: rand(-0.6, 0.6),
        vr: rand(-2.5, 2.5),
        size: rand(6, 13),
        life: rand(1.0, 2.0),
        age: 0,
        color: pick(HEART_COLORS)
      });
    }
    startBurstLoop();
  }

  function heartBurst(x, y, count) {
    if (!supported || reducedMotion()) return;
    whenBodyReady(function () {
      try {
        doHeartBurst(x, y, count);
      } catch (err) { /* молча */ }
    });
  }

  /* =================== 4. Искорки за курсором мыши ======================= */

  var trailCanvas = null;
  var trailCtx = null;
  var sparkles = [];
  var trailRafId = 0;
  var trailRunning = false;
  var lastTrailTime = 0;
  var lastSpawn = { x: -1, y: -1, t: 0 };
  var moveEventName = (typeof window.PointerEvent === 'function') ? 'pointermove' : 'mousemove';

  var MAX_SPARKLES = 120; // потолок искр — даже при бешеном дёргании мыши
  var SPARKLE_COLORS = ['#ffe9a8', '#ffd98a', '#fff6d9', '#f5d76e'];

  // Четырёхлучевая искра-звёздочка с вогнутыми гранями
  function sparklePath(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.18, -r * 0.18, r, 0);
    ctx.quadraticCurveTo(r * 0.18, r * 0.18, 0, r);
    ctx.quadraticCurveTo(-r * 0.18, r * 0.18, -r, 0);
    ctx.quadraticCurveTo(-r * 0.18, -r * 0.18, 0, -r);
    ctx.closePath();
  }

  // Активируем искры только там, где есть настоящий курсор мыши
  function hasFinePointer() {
    try {
      if (typeof window.matchMedia === 'function' &&
          window.matchMedia('(pointer: fine)').matches) {
        return true;
      }
    } catch (err) { /* ниже запасной вариант */ }
    // нет matchMedia или указатель не «fine» — смотрим тач-признаки
    return !('ontouchstart' in window) &&
      !(navigator.maxTouchPoints > 0) &&
      !(navigator.msMaxTouchPoints > 0);
  }

  function onPointerMove(e) {
    if (!trailCtx) return;
    // страховка для гибридных устройств: пальцем искры не рисуем
    if (e && e.pointerType === 'touch') return;

    var now = nowMs();
    if (now - lastSpawn.t < 20) return;                     // троттлинг ~50 раз/с
    var dx = e.clientX - lastSpawn.x;
    var dy = e.clientY - lastSpawn.y;
    if (lastSpawn.x >= 0 && dx * dx + dy * dy < 16) return; // курсор почти не двигался

    lastSpawn.x = e.clientX;
    lastSpawn.y = e.clientY;
    lastSpawn.t = now;

    if (sparkles.length >= MAX_SPARKLES) return;            // потолок частиц

    var n = Math.random() < 0.35 ? 2 : 1;
    for (var i = 0; i < n; i++) {
      sparkles.push({
        x: e.clientX + rand(-5, 5),
        y: e.clientY + rand(-5, 5),
        vx: rand(-18, 18),
        vy: rand(-45, -8),      // искорки чуть всплывают и тают
        r: rand(1.6, 4.2),
        rot: rand(0, Math.PI),
        vr: rand(-3, 3),
        life: rand(0.45, 0.9),
        age: 0,
        color: pick(SPARKLE_COLORS)
      });
    }
    startTrailLoop();
  }

  function startTrailLoop() {
    if (trailRunning) return;
    trailRunning = true;
    lastTrailTime = nowMs();
    trailRafId = raf(drawSparkles);
  }

  function drawSparkles(now) {
    if (!trailCtx) { // canvas убрали — гасим всё и не перепланируем
      sparkles = [];
      trailRunning = false;
      return;
    }
    var dt = frameDelta(now, lastTrailTime);
    lastTrailTime = now;

    var w = window.innerWidth;
    var h = window.innerHeight;
    trailCtx.clearRect(0, 0, w, h);

    for (var i = sparkles.length - 1; i >= 0; i--) {
      var s = sparkles[i];
      s.age += dt;
      if (s.age >= s.life) {
        sparkles.splice(i, 1); // отжившая искра покидает массив
        continue;
      }
      s.vx *= Math.exp(-2 * dt);  // искра теряет скорость и тает
      s.vy *= Math.exp(-2 * dt);
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.vr * dt;

      var t = s.age / s.life;
      // плавно таем, слегка мерцая на угасании
      var alpha = (1 - t) * (0.6 + 0.4 * Math.sin(s.age * 20 + s.r * 10));

      trailCtx.save();
      trailCtx.translate(s.x, s.y);
      trailCtx.rotate(s.rot);
      trailCtx.globalAlpha = Math.max(0, alpha);
      trailCtx.fillStyle = s.color;
      sparklePath(trailCtx, s.r * (1 - 0.3 * t)); // чуть съёживается
      trailCtx.fill();
      trailCtx.restore();
    }

    if (sparkles.length > 0) {
      trailRafId = raf(drawSparkles);
    } else {
      trailCtx.clearRect(0, 0, w, h);
      trailRunning = false; // курсор замер — цикл спит, CPU отдыхает
    }
  }

  function sparkleTrail() {
    if (!supported || reducedMotion()) return;
    if (trailCanvas) return;       // идемпотентность
    if (!hasFinePointer()) return; // тач-устройства — не активируемся

    whenBodyReady(function () {
      if (trailCanvas || !supported || reducedMotion()) return;
      try {
        trailCanvas = makeCanvas(9998);
        document.body.appendChild(trailCanvas);
        trailCtx = fitCanvas(trailCanvas);
        addResizer(function () {
          if (trailCanvas) trailCtx = fitCanvas(trailCanvas);
        });
        window.addEventListener(moveEventName, onPointerMove, { passive: true });
        // сбрасываем прошлую позицию, чтобы искры не «прыгали» с курсором
        lastSpawn.x = -1;
        lastSpawn.y = -1;
        lastSpawn.t = 0;
      } catch (err) {
        if (trailCanvas && trailCanvas.parentNode) {
          trailCanvas.parentNode.removeChild(trailCanvas);
        }
        trailCanvas = null;
        trailCtx = null;
      }
    });
  }

  /* ============ 5. Мягкое выключение всех эффектов ======================= */
  /* Если пользователь включил prefers-reduced-motion уже после загрузки —
     деликатно останавливаем все циклы и убираем canvas'ы из DOM. */

  function detachCanvas(canvas) {
    if (canvas && canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
  }

  function disableAll() {
    // небо
    if (starRafId) caf(starRafId);
    starRafId = 0;
    stars = [];
    dust = [];
    shooting = null;
    detachCanvas(starCanvas);
    starCanvas = null;
    starCtx = null;

    // сердечки
    if (burstRafId) caf(burstRafId);
    burstRafId = 0;
    burstRunning = false;
    hearts = [];
    detachCanvas(burstCanvas);
    burstCanvas = null;
    burstCtx = null;

    // искры
    if (trailRafId) caf(trailRafId);
    trailRafId = 0;
    trailRunning = false;
    sparkles = [];
    window.removeEventListener(moveEventName, onPointerMove);
    detachCanvas(trailCanvas);
    trailCanvas = null;
    trailCtx = null;

    // resize-обработчики больше не нужны — canvas'ов нет
    resizers.length = 0;
  }

  try {
    if (mqReduce) {
      var onReduceChange = function (ev) {
        var active = ev && typeof ev.matches === 'boolean' ? ev.matches : mqReduce.matches;
        if (active) disableAll();
      };
      if (typeof mqReduce.addEventListener === 'function') {
        mqReduce.addEventListener('change', onReduceChange);
      } else if (typeof mqReduce.addListener === 'function') {
        mqReduce.addListener(onReduceChange);
      }
    }
  } catch (err) { /* ладно: базовая проверка при вызовах уже сделана */ }

  /* ========================= 6. Публичный API ============================ */

  // Обёртка-страховка: наружу никогда не улетают исключения
  function safe(fn) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (err) {
        /* эффекты не должны ломать страницу */
      }
    };
  }

  return {
    initStarfield: safe(initStarfield),
    heartBurst: safe(heartBurst),
    sparkleTrail: safe(sparkleTrail)
  };
})();
