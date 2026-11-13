/*!
 * particle-heart.js — «3D-сердце из частиц» для сайта-открытки ко Дню Рождения.
 * Тема «ночное небо»: тёмно-синий фон, золото #f5d76e / #ffd98a и розовый #ff9ebb.
 *
 * Подключение (классический скрипт, без зависимостей, работает по file://):
 *   <script src="assets/particle-heart.js"></script>
 *   <script>
 *     window.ParticleHeart.init(document.getElementById('heart-canvas'));
 *   </script>
 *
 * Что происходит на canvas (CSS-размер задаёт страница, модуль учитывает DPR до 2×):
 *   - объёмное сердце из ~890 светящихся точек-«бусин»: параметрическая кривая сердца
 *     x = 16·sin³t, y = 13·cos t − 5·cos 2t − 2·cos 3t − cos 4t (нормирована в ~[-1, 1]);
 *     объём — нарезкой по оси Z: каждый слой сжат «выпуклым бугром» sqrt(1 − (z/zMax)²),
 *     точки лежат на контуре слоя + немного точек внутри (заполнение, не пустой контур);
 *   - медленное вращение вокруг вертикальной оси Y (~14 с на оборот) и лёгкий наклон
 *     камеры rotateX ≈ −0.2 рад, чтобы читался 3D-объём;
 *   - перспективная проекция scale = fov / (fov + z): ближние точки крупнее и ярче,
 *     дальние мельче и тусклее;
 *   - мягкое «биение» масштабом 1 → 1.05 → 1 → 1.09 → 1 (двойной удар, период ~1.7 c);
 *   - тонкая наклонная орбита из ~70 мелких точек, вращается в противофазе к сердцу;
 *   - фон canvas прозрачный (clearRect), точки рисуются готовыми спрайтами
 *     (offscreen-canvas с радиальным градиентом) — дёшево на каждый кадр, без shadowBlur.
 *
 * Поведение и безопасность:
 *   - init идемпотентен: повторный вызов с тем же canvas не создаёт второй цикл;
 *   - resize / ResizeObserver → пересчёт размеров и проекции;
 *   - prefers-reduced-motion: reduce → один статичный кадр, без анимации;
 *   - rAF-цикл останавливается, если canvas удалён из DOM (isConnected) или вкладка
 *     скрыта (document.hidden), и возобновляется при возвращении;
 *   - весь init обёрнут в try/catch: никаких исключений наружу; если 2D-контекст
 *     недоступен — тихий no-op.
 */
window.ParticleHeart = (function () {
  'use strict';

  /* ==================== ПАЛИТРА «НОЧНОГО НЕБА» ==================== */
  // Индексы: 0 и 1 — два оттенка золота, 2 — розовый. Итог: ~60% золота / 40% розового.
  var COLORS_RGB = ['245,215,110', '255,217,138', '255,158,187']; // для спрайтов-градиентов
  var COLORS_HEX = ['#f5d76e', '#ffd98a', '#ff9ebb'];             // запасной вариант без спрайтов

  /* ==================== ПАРАМЕТРЫ СЦЕНЫ ==================== */
  var FOV = 3.2;             // «фокус» перспективы: scale = FOV / (FOV + z)
  var TILT = -0.2;           // наклон камеры вокруг оси X, рад
  var ROT_PERIOD = 14;       // секунд на оборот сердца вокруг Y (задумано 12–16 c)
  var ORBIT_PERIOD = 10.5;   // секунд на оборот орбиты (вращается в обратную сторону)
  var PULSE_PERIOD = 1.7;    // период «биения», c

  var HEART_LAYERS = 16;     // количество слоёв по оси Z
  var HEART_ZMAX = 0.52;     // полу-толщина сердца в нормированных координатах
  var FILL_PER_LAYER = 14;   // точек заполнения внутри каждого слоя
  // Точек на контуре слоя: 12 + 44·s², где s — коэффициент «бугра» слоя
  // (внешние широкие слои гуще, узкие внутренние реже). Всего выходит ~886 точек.

  var ORBIT_COUNT = 70;      // точек в орбите
  var ORBIT_R = 1.36;        // радиус орбиты (сердце с пульсом умещается в ~1.05)
  var ORBIT_TILT_X = 0.42;   // наклон плоскости орбиты — тонкий эллипс, как на референсе
  var ORBIT_TILT_Z = 0.18;   // лёгкий доворот орбиты для живости

  var HEART_SCALE = 0.32;    // масштаб: радиус сердца = min(w, h) * HEART_SCALE
  var CURVE_SAMPLES = 220;   // плотность таблицы кривой (перепараметризация по длине дуги)

  /* ==================== УТИЛИТЫ ==================== */

  // Ограничение значения диапазоном
  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // Обёртка «тихого» вызова: исключение никогда не покидает модуль
  function safe(fn) {
    return function (arg) {
      try {
        return fn(arg);
      } catch (e) {
        /* открытка не должна падать — молча игнорируем */
      }
    };
  }

  // Спрайт-«бусина»: маленький offscreen-canvas с радиальным градиентом.
  // Готовится один раз на цвет — в кадре остаётся только дешёвый drawImage.
  function makeSprite(rgb) {
    var size = 32;
    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    var g = c.getContext('2d');
    if (!g) return null;
    var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(' + rgb + ',1)');      // яркое ядро
    grad.addColorStop(0.3, 'rgba(' + rgb + ',0.75)'); // тело бусины
    grad.addColorStop(0.6, 'rgba(' + rgb + ',0.18)'); // мягкий ореол
    grad.addColorStop(1, 'rgba(' + rgb + ',0)');      // полное затухание
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  // Мягкое «биение»: два гауссовых удара на периоде → 1 → 1.05 → 1 → 1.09 → 1
  function pulseScale(t) {
    var p = (t % PULSE_PERIOD) / PULSE_PERIOD;
    var beat1 = Math.exp(-Math.pow((p - 0.10) / 0.055, 2)); // первый удар — послабее
    var beat2 = Math.exp(-Math.pow((p - 0.34) / 0.065, 2)); // второй удар — посильнее
    return 1 + 0.05 * beat1 + 0.09 * beat2;
  }

  /* ==================== ГЕОМЕТРИЯ ==================== */

  // Параметрическая кривая сердца, перепараметризованная по длине дуги
  // и нормированная в диапазон примерно [-1, 1]:
  //   x = 16·sin³t,  y = 13·cos t − 5·cos 2t − 2·cos 3t − cos 4t
  function buildHeartCurve() {
    var N = 256;
    var raw = [];
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    var i, t, x, y;

    for (i = 0; i < N; i++) {
      t = i / N * Math.PI * 2;
      x = 16 * Math.pow(Math.sin(t), 3);
      y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      raw.push([x, y]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // Центрируем по вертикали и нормируем: сердце занимает ~[-0.96, 0.96]
    var cy = (minY + maxY) / 2;
    var k = 0.96 / (Math.max(maxX - minX, maxY - minY) / 2);

    // Перепараметризация по длине дуги — бусины лягут по контуру равномерно
    var cum = [0];
    for (i = 1; i <= N; i++) {
      var a = raw[i - 1];
      var b = raw[i % N]; // замыкаем контур
      var dx = b[0] - a[0];
      var dy = b[1] - a[1];
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    var total = cum[N];

    var curve = [];
    var seg = 0;
    for (i = 0; i < CURVE_SAMPLES; i++) {
      var target = total * i / CURVE_SAMPLES;
      while (seg < N - 1 && cum[seg + 1] < target) seg++;
      a = raw[seg];
      b = raw[(seg + 1) % N];
      var segLen = (cum[seg + 1] - cum[seg]) || 1;
      var f = clamp((target - cum[seg]) / segLen, 0, 1);
      curve.push([
        (a[0] + (b[0] - a[0]) * f) * k,
        (a[1] + (b[1] - a[1]) * f - cy) * k
      ]);
    }
    return curve;
  }

  // Точка внутри полигона? (лучcasting — нужно для заполнения сердца)
  function pointInPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1];
      var xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Одна частица сердца
  function makePoint(x, y, z, size, alpha, colorIdx) {
    return {
      x: x, y: y, z: z,                  // позиция в модели (нормированные координаты)
      s: size,                           // базовый радиус бусины, CSS-px
      a: alpha,                          // базовая непрозрачность
      c: colorIdx,                       // индекс цвета/спрайта
      twS: 0.8 + Math.random() * 1.2,    // скорость мерцания, рад/с
      twP: Math.random() * Math.PI * 2   // фаза мерцания
    };
  }

  // Цвет частицы: ~60% золота (два оттенка) и ~40% розового
  function pickColor() {
    var r = Math.random();
    return r < 0.3 ? 0 : (r < 0.6 ? 1 : 2);
  }

  // Облако точек сердца: слои по Z («выпуклый бугор») + контур слоя + заполнение внутри
  function buildHeartPoints() {
    var curve = buildHeartCurve();
    var M = curve.length;
    var pts = [];
    var l, c, f, z, s, q;

    for (l = 0; l < HEART_LAYERS; l++) {
      // позиция слоя по Z и его коэффициент «выпуклого бугра» sqrt(1 − (z/zMax)²)
      z = -HEART_ZMAX + (l + 0.5) * (2 * HEART_ZMAX / HEART_LAYERS);
      s = Math.sqrt(1 - (z / HEART_ZMAX) * (z / HEART_ZMAX));

      // полигон слоя (сжатый контур) — по нему отбираем точки заполнения
      var poly = [];
      for (c = 0; c < M; c += 4) {
        poly.push([curve[c][0] * s, curve[c][1] * s]);
      }
      var bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
      for (c = 0; c < poly.length; c++) {
        q = poly[c];
        if (q[0] < bx0) bx0 = q[0];
        if (q[0] > bx1) bx1 = q[0];
        if (q[1] < by0) by0 = q[1];
        if (q[1] > by1) by1 = q[1];
      }

      // 1) бусины на контуре слоя: равномерно по кривой + лёгкий органический джиттер;
      //    внешние (широкие) слои получают больше точек, чем узкие внутренние
      var contourN = Math.max(8, Math.round(12 + 44 * s * s));
      for (c = 0; c < contourN; c++) {
        var idx = Math.floor((c + Math.random() * 0.8) / contourN * M) % M;
        q = curve[idx];
        pts.push(makePoint(
          q[0] * s + (Math.random() - 0.5) * 0.045,
          q[1] * s + (Math.random() - 0.5) * 0.045,
          z + (Math.random() - 0.5) * 0.06,
          Math.min(1.75, 0.7 + Math.random() * 0.75 + (Math.random() < 0.08 ? 0.4 : 0)), // редкие «искры» крупнее
          0.55 + Math.random() * 0.35,
          pickColor()
        ));
      }

      // 2) немного точек внутри слоя — чтобы сердце не было пустым контуром
      for (f = 0; f < FILL_PER_LAYER; f++) {
        var fx = 0, fy = 0, ok = false, tries;
        for (tries = 0; tries < 16; tries++) {
          fx = bx0 + Math.random() * (bx1 - bx0);
          fy = by0 + Math.random() * (by1 - by0);
          if (pointInPoly(fx, fy, poly)) { ok = true; break; }
        }
        if (!ok) {
          // страховка: точка на полпути от центра к случайному месту контура
          q = curve[Math.floor(Math.random() * M)];
          fx = q[0] * s * 0.5;
          fy = q[1] * s * 0.5;
        }
        pts.push(makePoint(
          fx + (Math.random() - 0.5) * 0.02,
          fy + (Math.random() - 0.5) * 0.02,
          z + (Math.random() - 0.5) * 0.05,
          0.5 + Math.random() * 0.6,
          0.3 + Math.random() * 0.3,
          pickColor()
        ));
      }
    }
    return pts;
  }

  // Орбита: тонкое кольцо из мелких точек, наклонённое к сердцу
  function buildOrbitPoints() {
    var pts = [];
    for (var i = 0; i < ORBIT_COUNT; i++) {
      pts.push({
        phi: i / ORBIT_COUNT * Math.PI * 2 + (Math.random() - 0.5) * 0.06, // стартовый угол
        r: ORBIT_R * (1 + (Math.random() - 0.5) * 0.05),                   // лёгкий разброс радиуса
        s: 0.45 + Math.random() * 0.4,
        a: 0.35 + Math.random() * 0.35,
        c: Math.random() < 0.85 ? 0 : 2,   // в основном золото, изредка розовый
        twS: 0.8 + Math.random() * 1.2,
        twP: Math.random() * Math.PI * 2
      });
    }
    return pts;
  }

  /* ==================== ИНИЦИАЛИЗАЦИЯ ОДНОГО CANVAS ==================== */

  function init(canvas) {
    // Не canvas (нет метода getContext) — тихо выходим
    if (!canvas || typeof canvas.getContext !== 'function') return;
    // Идемпотентность: этот canvas уже живёт со своим циклом, дубликаты не нужны
    if (canvas.__particleHeart) return;

    var ctx = canvas.getContext('2d');
    if (!ctx) return; // 2D-контекст недоступен (например, занят под WebGL) — тихий no-op

    // Спрайты свечения готовим один раз на инициализацию
    var sprites = [
      makeSprite(COLORS_RGB[0]),
      makeSprite(COLORS_RGB[1]),
      makeSprite(COLORS_RGB[2])
    ];

    // Геометрия строится один раз при инициализации
    var heart = buildHeartPoints();
    var orbit = buildOrbitPoints();

    // Состояние сцены
    var w = 0, h = 0;          // CSS-размеры холста (0 — раскладки ещё не было)
    var rotY = 0.6;            // текущий угол вращения сердца, рад
    var rafId = null;          // id кадра rAF; null — цикл не запущен
    var lastTime = 0;          // метка времени прошлого кадра
    var reduced = false;       // prefers-reduced-motion активен?
    var mq = null;             // matchMedia('(prefers-reduced-motion: reduce)')

    var ROT_SPEED = Math.PI * 2 / ROT_PERIOD;   // рад/с — сердце
    var ORB_SPEED = Math.PI * 2 / ORBIT_PERIOD; // рад/с — орбита (в обратную сторону)

    // Тригонометрия наклона орбиты постоянна — считаем один раз
    var cosG = Math.cos(ORBIT_TILT_Z), sinG = Math.sin(ORBIT_TILT_Z);
    var cosH = Math.cos(ORBIT_TILT_X), sinH = Math.sin(ORBIT_TILT_X);

    /* ---- размер холста: DPR ограничен 2×, рисуем в CSS-координатах ---- */
    function resize() {
      var dpr = clamp(window.devicePixelRatio || 1, 0.5, 2) || 1;
      var cw = canvas.clientWidth;
      var ch = canvas.clientHeight;
      if (!cw || !ch) { // холст без раскладки (display:none и т.п.) — рисовать некуда
        w = 0;
        h = 0;
        return;
      }
      w = cw;
      h = ch;
      var pw = Math.round(cw * dpr);
      var ph = Math.round(ch * dpr);
      // Защитный ограничитель: если страница не задала canvas CSS-размер, атрибуты
      // width/height сами влияют на раскладку — не даём им расти бесконечно
      pw = Math.min(pw, 4096);
      ph = Math.min(ph, 4096);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw; // смена размера сбрасывает состояние контекста
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // дальше рисуем в CSS-пикселях
    }

    /* ---- отрисовка одного кадра ---- */
    function render(nowMs) {
      if (w < 2 || h < 2) return; // некуда рисовать
      var t = nowMs * 0.001;
      var pulse = pulseScale(t);

      ctx.clearRect(0, 0, w, h); // прозрачный фон — сквозь него виден фон страницы
      ctx.globalCompositeOperation = 'lighter'; // свечение: яркость точек складывается

      var cx = w * 0.5;
      var cy = h * 0.5;
      var S = Math.min(w, h) * HEART_SCALE;
      var cosA = Math.cos(rotY), sinA = Math.sin(rotY);
      var cosB = Math.cos(TILT), sinB = Math.sin(TILT);

      var i, p, mx, my, mz, px, pz, ry, rz, sx, sy;
      var persp, depth, size, alpha, half, tw, spr;

      /* --- сердце: вращение вокруг Y → наклон камеры → перспектива --- */
      for (i = 0; i < heart.length; i++) {
        p = heart[i];
        // «биение» — мягкое масштабирование всей модели
        mx = p.x * pulse;
        my = p.y * pulse;
        mz = p.z * pulse;

        // вращение вокруг вертикальной оси Y
        px = mx * cosA + mz * sinA;
        pz = -mx * sinA + mz * cosA;

        // лёгкий наклон камеры вокруг оси X — читается 3D-объём
        ry = my * cosB - pz * sinB;
        rz = my * sinB + pz * cosB;

        // простая перспектива: scale = fov / (fov + z)
        persp = FOV / (FOV + rz);

        // глубина → размер и яркость: ближние крупнее/ярче, дальние мельче/тусклее
        depth = clamp((persp - 0.85) / 0.5, 0, 1);
        tw = 0.78 + 0.22 * Math.sin(t * p.twS + p.twP); // лёгкое мерцание каждой бусины
        size = p.s * (0.72 + 0.5 * depth);
        alpha = clamp(p.a * (0.38 + 0.62 * depth) * tw, 0.05, 1);

        sx = cx + px * persp * S;
        sy = cy - ry * persp * S; // ось Y модели смотрит вверх на экране

        half = size * 3; // спрайт = ядро-бусина + ореол свечения вокруг
        spr = sprites[p.c];
        if (spr) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(spr, sx - half, sy - half, half * 2, half * 2);
        } else {
          // запасной путь, если спрайт построить не удалось
          ctx.globalAlpha = alpha;
          ctx.fillStyle = COLORS_HEX[p.c];
          ctx.beginPath();
          ctx.arc(sx, sy, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      /* --- орбита: тонкое наклонное кольцо, вращается в противофазе к сердцу --- */
      var orbPhase = -t * ORB_SPEED; // минус — направление, обратное вращению сердца
      for (i = 0; i < orbit.length; i++) {
        p = orbit[i];
        var phi = p.phi + orbPhase;
        var ox = Math.cos(phi) * p.r;
        var oz = Math.sin(phi) * p.r;
        var oy = 0;

        // фиксированный наклон плоскости орбиты: доворот вокруг Z, затем вокруг X
        var x1 = ox * cosG - oy * sinG;
        var y1 = ox * sinG + oy * cosG;
        var z1 = oz;
        ry = y1 * cosH - z1 * sinH;
        rz = y1 * sinH + z1 * cosH;

        persp = FOV / (FOV + rz);
        depth = clamp((persp - 0.85) / 0.5, 0, 1);
        tw = 0.78 + 0.22 * Math.sin(t * p.twS + p.twP);
        size = p.s * (0.72 + 0.5 * depth);
        alpha = clamp(p.a * (0.38 + 0.62 * depth) * tw, 0.05, 1);

        sx = cx + x1 * persp * S;
        sy = cy - ry * persp * S;

        half = size * 3;
        spr = sprites[p.c];
        if (spr) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(spr, sx - half, sy - half, half * 2, half * 2);
        } else {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = COLORS_HEX[p.c];
          ctx.beginPath();
          ctx.arc(sx, sy, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // Статичный ракурс для prefers-reduced-motion: t = 1.2 c — фаза биения в покое
    function drawStaticFrame() {
      rotY = 0.6;
      resize();
      render(1200);
    }

    /* ---- цикл анимации ---- */
    function tick(now) {
      rafId = null;
      if (!canvas.isConnected) return; // canvas удалён из DOM — цикл больше не нужен
      if (document.hidden) return;     // вкладка скрыта — не жжём CPU впустую

      // dt с ограничением, чтобы после паузы не было рывка
      var dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0.016;
      lastTime = now;
      rotY += dt * ROT_SPEED; // ~14 секунд на полный оборот

      try {
        render(now);
      } catch (e) {
        return; // сбой отрисовки — тихо гасим цикл, чтобы не спамить ошибками
      }
      rafId = window.requestAnimationFrame(tick);
    }

    function stopLoop() {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function startLoop() {
      if (rafId !== null) return;       // цикл уже работает
      if (document.hidden) return;      // ждём visibilitychange
      if (!canvas.isConnected) return;  // canvas не в DOM
      if (reduced) {                    // движение отключено — только статичный кадр
        drawStaticFrame();
        return;
      }
      lastTime = 0;
      rafId = window.requestAnimationFrame(tick);
    }

    /* ---- события ---- */
    function onVisibility() {
      if (document.hidden) stopLoop();
      else startLoop();
    }

    function onResize() {
      resize();
      startLoop(); // на случай, если размеры холста появились позже инициализации
    }

    function onMotionPref() {
      reduced = !!(mq && mq.matches);
      if (reduced) {
        stopLoop();
        drawStaticFrame(); // пользователь просил меньше движения — статичное сердце
      } else {
        startLoop(); // движение снова разрешено — запускаем анимацию
      }
    }

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    // ResizeObserver (если поддерживается): следит за самим canvas, а не только за окном
    if (typeof ResizeObserver === 'function') {
      try {
        var ro = new ResizeObserver(onResize);
        ro.observe(canvas);
      } catch (e) { /* наблюдение не критично */ }
    }

    // prefers-reduced-motion: reduce → статичное сердце вместо анимации
    try {
      if (typeof window.matchMedia === 'function') {
        mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        reduced = !!(mq && mq.matches);
        if (typeof mq.addEventListener === 'function') {
          mq.addEventListener('change', onMotionPref);
        } else if (typeof mq.addListener === 'function') {
          mq.addListener(onMotionPref); // старые браузеры
        }
      }
    } catch (e) { /* нет поддержки — считаем, что движение разрешено */ }

    /* ---- запуск ---- */
    resize();
    startLoop();

    canvas.__particleHeart = true; // отметка идемпотентности: повторный init ничего не сделает
  }

  // Наружу отдаём только init, обёрнутый в «тихую» защиту от исключений
  return { init: safe(init) };
})();
