const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/sala", (req, res) => {
  res.sendFile(__dirname + "/sala.html");
});

// ================== ESTRUCTURAS ==================

let salas = {};
let relojesSalas = {};
let intervalosSalas = {};
let peligroSalas = {};
let timeoutsSalas = {};
let motoresSalas = {}
const RUMBOS_CIRCUITO = {
  upwind: 220,
  final: 220,
  downwind: 40,
  crosswind: 130,
  base: 310
}
const ALTITUD_CIRCUITO_FT = 1500
const ASCENSO_DESCENSO_CIRCUITO_FPM = 1200
const EPSILON_ALTITUD_MANUAL_CIRCUITO_FT = 50
const PUNTO_ORBITA_DOWNWIND = {
  lat: -13.76459547738987,
  lng: -76.19292298449697
}
const TOLERANCIA_PUNTO_ORBITA_M = 120
const TOLERANCIA_REINGRESO_ORBITA_M = 80
const ORBIT_TASA_VIRAJE_GRADOS_SEG = 3
const ORBIT_SENTIDO_DERECHA = 1
const INGRESO_DOWNWIND_ANGULO_GRADOS = 45
const INGRESO_CERCANO_MAX_DISTANCIA_M = 150
const INGRESO_DOWNWIND_PREENTRY_M = 0.9 * 1852
const INGRESO_DOWNWIND_CRUCE_M = 0.8 * 1852
const INGRESO_DOWNWIND_GOTA_M = 1.1 * 1852
const INGRESO_DOWNWIND_MIN_T = 0.2
const INGRESO_DOWNWIND_MAX_T = 0.8
const INGRESO_DOWNWIND_MIN_SEPARACION_WP_M = 80
const KNOTS_PER_MACH = 661.47
const SPEED_CONTROL_MAX_MACH = 10
const SPEED_CONTROL_MAX_KNOTS = Math.round(KNOTS_PER_MACH * SPEED_CONTROL_MAX_MACH)
const SCO_VOR_COORDS = { lat: -13.738556, lng: -76.212750 }
const GO_AROUND_TRIGGER_POINT = {
  lat: -13.737274259116425,
  lng: -76.21411085128786
}
const GO_AROUND_TRIGGER_HEADING = 222
const GO_AROUND_TRIGGER_HEADING_TOL = 8
const GO_AROUND_TRIGGER_DISTANCE_M = 140
const GO_AROUND_RADIAL_OBJETIVO = 250
const GO_AROUND_INTERCEPT_TOL = 3
const GO_AROUND_CLIMB_TARGET_FT = 2000
const GO_AROUND_CLIMB_RATE_FPM = 1200
const GO_AROUND_SPEED_DEFAULT_KT = 90
const GO_AROUND_MANUAL_SWITCH_DISTANCE_M = 5 * 1852
const INTERCEPT_LEG_LOOKAHEAD_MIN_M = 90
const INTERCEPT_LEG_LOOKAHEAD_MAX_M = 430
const INTERCEPT_LEG_BLEND_DISTANCE_M = 900
const INTERCEPT_LEG_HEADING_SMOOTH_FACTOR = 0.24
const INTERCEPT_LEG_MAX_TURN_FAR_DEG = 1.1
const INTERCEPT_LEG_MAX_TURN_NEAR_DEG = 1.9
const INTERCEPT_LEG_FORCE_CAPTURE_TICKS = 280
const INTERCEPT_LEG_FORCE_CAPTURE_DISTANCE_M = 140
const INTERCEPT_LEG_RESCUE_CAPTURE_TICKS = 120
const INTERCEPT_LEG_RESCUE_CAPTURE_DISTANCE_M = 240
const INTERCEPT_LEG_HARD_TIMEOUT_TICKS = 520
// ================== UTILIDADES ==================

function convertirHoraASegundos(horaStr) {
  const [h, m, s] = horaStr.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function formatearHora(segundosTotales) {
  segundosTotales = Math.floor(segundosTotales % 86400);

  const h = Math.floor(segundosTotales / 3600).toString().padStart(2, "0");
  const m = Math.floor((segundosTotales % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(segundosTotales % 60).toString().padStart(2, "0");

  return { horas: h, minutos: m, segundos: s };
}

function obtenerListaSalas() {
  return Object.keys(salas).map(nombre => ({
    nombre,
    jugadores: salas[nombre].jugadores.length
  }));
}

function limpiarOrbitacionAeronave(aeronave) {
  if (!aeronave) return

  aeronave.orbitPendiente = false
  aeronave.orbitEnCurso = false
  aeronave.orbitModoContinuo = false
  aeronave.orbitDetenerSolicitado = false
  aeronave.orbitCentro = null
  aeronave.orbitRadio = null
  aeronave.orbitBearing = null
  aeronave.orbitAcumulado = 0
}

function esEstadoCircuitoConAltitudAutomatica(estado) {
  return (
    estado === "CIRCUIT" ||
    estado === "INTERCEPTING ARC" ||
    estado === "INTERCEPTING LEG" ||
    estado === "ORBT"
  )
}

function actualizarAltitudCircuitoProgresiva(aeronave, intervaloMS) {
  if (!aeronave) return
  if (!aeronave.altitudCircuitoAutomaticaActiva) return
  if (!esEstadoCircuitoConAltitudAutomatica(aeronave.estado)) return

  const altitudActual = Number.isFinite(aeronave.altitud) ? aeronave.altitud : 0
  const cambioPorTick =
    (ASCENSO_DESCENSO_CIRCUITO_FPM / 60) * (intervaloMS / 1000)

  if (!Number.isFinite(cambioPorTick) || cambioPorTick <= 0) {
    return
  }

  const diferenciaAltitud = ALTITUD_CIRCUITO_FT - altitudActual

  if (Math.abs(diferenciaAltitud) <= cambioPorTick) {
    aeronave.altitud = ALTITUD_CIRCUITO_FT
    return
  }

  aeronave.altitud = altitudActual + (Math.sign(diferenciaAltitud) * cambioPorTick)
}

// ================== RELOJ POR SALA ==================

function iniciarRelojSala(nombre) {

  // Evitar duplicados
  if (intervalosSalas[nombre]) return;

  intervalosSalas[nombre] = setInterval(() => {

    const hora = obtenerHoraActualSala(nombre);
    if (!hora) return;

    io.to(nombre).emit("horaSala", hora);

  }, 1000);
}



function obtenerHoraActualSala(nombre) {

  const reloj = relojesSalas[nombre];
  if (!reloj) return null;

  if (reloj.pausado) {
    return formatearHora(reloj.tiempoBase);
  }

  const ahora = Date.now();
  const velocidadReloj =
    Number.isFinite(reloj.velocidad) && reloj.velocidad > 0
      ? reloj.velocidad
      : 1;
  const delta = (ahora - reloj.timestampBase) / 1000 * velocidadReloj;

  return formatearHora(reloj.tiempoBase + delta);
}
function iniciarMotorSala(nombreSala){

  if (motoresSalas[nombreSala]) return

  motoresSalas[nombreSala] = setInterval(() => {

    const sala = salas[nombreSala]
    if (!sala) return

    const intervaloMS = 50

    sala.aeronaves.forEach(a => {
// ðŸ”¥ PRIORIDAD ABSOLUTA LANDING
if (a.estado === "LANDING") {
  return
}
      if (procesarGoAroundEnMotor(a, intervaloMS, nombreSala)) {
        return
      }
      actualizarAltitudCircuitoProgresiva(a, intervaloMS)
      // =====================================
      // MODO MANUAL  PRIORIDAD ABSOLUTA
      // =====================================
      if (
        a.estado === "MANUAL" ||
        a.estado === "AUTO" ||
        (
          a.estado === "CLEARED TO LAND" &&
          (!a.ruta || a.ruta.length < 2)
        )
      ) {

  const velocidadMPS =
    Number.isFinite(a.velocidad)
      ? Math.max(0, a.velocidad)
      : 0
  const distanciaTick = velocidadMPS * (intervaloMS / 1000)

  const nuevoPunto = puntoPlano(
    { lat: a.lat, lng: a.lng },
    a.angulo || 0,
    distanciaTick
  )

  a.lat = nuevoPunto.lat
  a.lng = nuevoPunto.lng

  io.to(nombreSala).emit("actualizarAeronave", {
    id: a.id,
    lat: a.lat,
    lng: a.lng,
    altitud: a.altitud,
    angulo: a.angulo,
    velocidad: a.velocidad,
    velocidadObjetivo: a.velocidadObjetivo,
    estado: a.estado
  })

  return
}

      if (!a.ruta || a.ruta.length < 2) return

      const velocidadMPS =
        (Number.isFinite(a.velocidadObjetivo) && a.velocidadObjetivo > 0)
          ? a.velocidadObjetivo * 0.514444
          : (
            (Number.isFinite(a.velocidad) && a.velocidad > 0)
              ? a.velocidad
              : (90 * 0.514444)
          )
      const distanciaTick = velocidadMPS * (intervaloMS/1000)
// =====================================
// ðŸŒ€ FASE ARCO 30° ANTES DE INTERCEPTAR
// =====================================

if (a.estado === "INTERCEPTING ARC") {

  const destino =
    (Array.isArray(a.ingresoDownwindWaypoints) && a.ingresoDownwindWaypoints.length > 0)
      ? a.ingresoDownwindWaypoints[0]
      : a.puntoIntercepto;
  if (!destino) {
    a.estado = "INTERCEPTING LEG";
    a.interceptTicks = 0;
    a.interceptHeadingRef = null;
    return;
  }

  const distancia = distanciaEntre(
    { lat: a.lat, lng: a.lng },
    destino
  );

  const velocidadMPS =
    (Number.isFinite(a.velocidadObjetivo) && a.velocidadObjetivo > 0)
      ? a.velocidadObjetivo * 0.514444
      : (
        (Number.isFinite(a.velocidad) && a.velocidad > 0)
          ? a.velocidad
          : (90 * 0.514444)
      );
  const distanciaTick = velocidadMPS * (intervaloMS / 1000);

  // ðŸ”¥ RUMBO HACIA EL PUNTO DE INTERCEPTO
  const rumboObjetivo = calcularRumboServidor(
    { lat: a.lat, lng: a.lng },
    destino
  );

  const diff = diferenciaAngular(a.angulo || 0, rumboObjetivo);
  const maxGiro = 2;

  if (Math.abs(diff) < maxGiro) {
    a.angulo = rumboObjetivo;
  } else {
    a.angulo += Math.sign(diff) * maxGiro;
  }

  a.angulo = (a.angulo + 360) % 360;

  const nuevoPunto = puntoPlano(
    { lat: a.lat, lng: a.lng },
    a.angulo,
    distanciaTick
  );

  a.lat = nuevoPunto.lat;
  a.lng = nuevoPunto.lng;

  // ðŸŽ¯ Cuando estÃ© cerca â†’ pasar a interceptaciÃ³n fina
  if (distancia < 120) {
    if (Array.isArray(a.ingresoDownwindWaypoints) && a.ingresoDownwindWaypoints.length > 0) {
      a.ingresoDownwindWaypoints.shift()

      if (a.ingresoDownwindWaypoints.length > 0) {
        a.puntoIntercepto = a.ingresoDownwindWaypoints[0]
      } else {
        a.ingresoDownwindWaypoints = null
        a.ingresoDownwindTipo = null
        a.puntoIntercepto = null
        a.estado = "INTERCEPTING LEG";
        a.interceptTicks = 0;
        a.interceptHeadingRef = null;
      }
    } else {
      a.estado = "INTERCEPTING LEG";
      a.interceptTicks = 0;
      a.interceptHeadingRef = null;
    }
  }

  io.to(nombreSala).emit("actualizarAeronave", {
    id: a.id,
    lat: a.lat,
    lng: a.lng,
    altitud: a.altitud,
    angulo: a.angulo,
    velocidad: a.velocidad,
    velocidadObjetivo: a.velocidadObjetivo,
    estado: a.estado
  });

  return;
}
      // =====================================
      // FASE 1  INTERCEPTANDO EL CIRCUITO
      // =====================================
if (a.estado === "INTERCEPTING LEG") {

  if (!Number.isFinite(a.tramoObjetivo)) {
    a.tramoObjetivo = 0;
  }
  a.tramoObjetivo =
    ((a.tramoObjetivo % a.ruta.length) + a.ruta.length) % a.ruta.length;

  const A = a.ruta[a.tramoObjetivo];
  const B = a.ruta[(a.tramoObjetivo - 1 + a.ruta.length) % a.ruta.length];
  if (!A || !B) {
    a.ingresoDownwindWaypoints = null
    a.ingresoDownwindTipo = null
    a.estado = "CIRCUIT";
    a.interceptTicks = 0;
    a.interceptHeadingRef = null;
    return;
  }

  const distanciaSegmento = Math.max(1, distanciaEntre(A, B));

  // Proyeccion sobre tramo + punto adelantado para evitar oscilacion.
  const proyeccion = proyectarSobreSegmentoConFactor(
    { lat: a.lat, lng: a.lng },
    A,
    B
  );
  const puntoProyectado = proyeccion.punto;

  const distanciaAlTramo = distanciaEntre(
    { lat: a.lat, lng: a.lng },
    puntoProyectado
  );

  const anticipacionM = Math.max(
    INTERCEPT_LEG_LOOKAHEAD_MIN_M,
    Math.min(INTERCEPT_LEG_LOOKAHEAD_MAX_M, distanciaTick * 14)
  );
  const tGuiado = Math.min(1, proyeccion.t + (anticipacionM / distanciaSegmento));
  const puntoGuiado = {
    lat: A.lat + (B.lat - A.lat) * tGuiado,
    lng: A.lng + (B.lng - A.lng) * tGuiado
  };

  // Rumbo de guiado al tramo (sin cortar hacia atras del segmento).
  const rumboIntercepto = calcularRumboServidor(
    { lat: a.lat, lng: a.lng },
    puntoGuiado
  );

  const rumboTramo = calcularRumboServidor(A, B);

  // Mezcla progresiva: de intercepto al rumbo de tramo.
  const factorCurva = Math.max(
    0,
    Math.min(1, 1 - (distanciaAlTramo / INTERCEPT_LEG_BLEND_DISTANCE_M))
  );

  const rumboObjetivoBase = interpolarRumbo(
    rumboIntercepto,
    rumboTramo,
    factorCurva
  );

  if (!Number.isFinite(a.interceptHeadingRef)) {
    a.interceptHeadingRef = rumboObjetivoBase;
  } else {
    a.interceptHeadingRef = interpolarRumbo(
      a.interceptHeadingRef,
      rumboObjetivoBase,
      INTERCEPT_LEG_HEADING_SMOOTH_FACTOR
    );
  }
  const rumboObjetivo = a.interceptHeadingRef;

  const maxGiro =
    INTERCEPT_LEG_MAX_TURN_FAR_DEG +
    (INTERCEPT_LEG_MAX_TURN_NEAR_DEG - INTERCEPT_LEG_MAX_TURN_FAR_DEG) *
      factorCurva;

  const headingActual = Number.isFinite(a.angulo) ? a.angulo : rumboObjetivo;
  const diff = diferenciaAngular(headingActual, rumboObjetivo);
  if (Math.abs(diff) < maxGiro) {
    a.angulo = rumboObjetivo;
  } else {
    a.angulo = headingActual + Math.sign(diff) * maxGiro;
  }

  a.angulo = (a.angulo + 360) % 360;

  const nuevoPunto = puntoPlano(
    { lat: a.lat, lng: a.lng },
    a.angulo,
    distanciaTick
  );

  a.lat = nuevoPunto.lat;
  a.lng = nuevoPunto.lng;

  const proyeccionFinal = proyectarSobreSegmentoConFactor(
    { lat: a.lat, lng: a.lng },
    A,
    B
  );
  const distanciaFinalAlTramo = distanciaEntre(
    { lat: a.lat, lng: a.lng },
    proyeccionFinal.punto
  );
  const errorRumbo = Math.abs(diferenciaAngular(a.angulo, rumboTramo));
  a.interceptTicks = (a.interceptTicks || 0) + 1;

  // Captura estable para evitar giros anormales y entrada brusca.
  const capturaPrecisa = distanciaFinalAlTramo < 22 && errorRumbo < 10;
  const capturaCercana =
    distanciaFinalAlTramo < 65 &&
    errorRumbo < 22 &&
    a.interceptTicks > 12;
  const capturaForzada =
    a.interceptTicks > INTERCEPT_LEG_FORCE_CAPTURE_TICKS &&
    distanciaFinalAlTramo < INTERCEPT_LEG_FORCE_CAPTURE_DISTANCE_M;
  const capturaRescate =
    a.interceptTicks > INTERCEPT_LEG_RESCUE_CAPTURE_TICKS &&
    distanciaFinalAlTramo < INTERCEPT_LEG_RESCUE_CAPTURE_DISTANCE_M;

  let puntoCaptura = proyeccionFinal.punto;
  let indiceCaptura = a.tramoObjetivo;
  let progresoCaptura = distanciaSegmento * proyeccionFinal.t;
  let rumboCaptura = rumboTramo;
  let capturaTimeout = false;

  if (a.interceptTicks > INTERCEPT_LEG_HARD_TIMEOUT_TICKS) {
    const proyeccionRuta = obtenerProyeccionRutaMasCercana(
      { lat: a.lat, lng: a.lng },
      a.ruta
    );
    if (proyeccionRuta) {
      capturaTimeout = true;
      indiceCaptura = proyeccionRuta.indiceA;
      if (proyeccionRuta.puntoIntercepto) {
        puntoCaptura = proyeccionRuta.puntoIntercepto;
      }
      if (Number.isFinite(proyeccionRuta.progreso)) {
        progresoCaptura = proyeccionRuta.progreso;
      }

      const ACaptura = a.ruta[indiceCaptura];
      const BCaptura = a.ruta[(indiceCaptura - 1 + a.ruta.length) % a.ruta.length];
      if (ACaptura && BCaptura) {
        rumboCaptura = calcularRumboServidor(ACaptura, BCaptura);
      }
    }
  }

  // Evita "retrocesos" visuales al capturar: nunca reducir t sobre el mismo tramo.
  if (!capturaTimeout) {
    const tCapturaSinRetroceso = Math.max(
      0,
      Math.min(1, Math.max(proyeccionFinal.t, proyeccion.t))
    );
    puntoCaptura = {
      lat: A.lat + (B.lat - A.lat) * tCapturaSinRetroceso,
      lng: A.lng + (B.lng - A.lng) * tCapturaSinRetroceso
    };
    progresoCaptura = distanciaSegmento * tCapturaSinRetroceso;
  }

  if (capturaPrecisa || capturaCercana || capturaForzada || capturaRescate || capturaTimeout) {
    a.lat = puntoCaptura.lat;
    a.lng = puntoCaptura.lng;
    a.angulo = interpolarRumbo(
      Number.isFinite(a.angulo) ? a.angulo : rumboCaptura,
      rumboCaptura,
      0.65
    );
    if (
      capturaTimeout ||
      Math.abs(diferenciaAngular(a.angulo, rumboCaptura)) < 3
    ) {
      a.angulo = rumboCaptura;
    }
    a.ingresoDownwindWaypoints = null
    a.ingresoDownwindTipo = null
    a.estado = "CIRCUIT";
    a.interceptTicks = 0;
    a.interceptHeadingRef = null;
    a.tramoObjetivo = indiceCaptura;
    a.indice = indiceCaptura;
    a.progreso = progresoCaptura;
  }

  io.to(nombreSala).emit("actualizarAeronave", {
    id: a.id,
    lat: a.lat,
    lng: a.lng,
    altitud: a.altitud,
    angulo: a.angulo,
    velocidad: a.velocidad,
    velocidadObjetivo: a.velocidadObjetivo,
    estado: a.estado
  });

  return;
}
      // =====================================
      //  FASE 2  MOVIMIENTO NORMAL EN CIRCUITO
      // =====================================
      if (
        a.estado !== "CIRCUIT" &&
        a.estado !== "ORBT" &&
        a.estado !== "CLEARED TO LAND"
      ) return

      if (a.orbitEnCurso) {
        const deltaAngular =
          ORBIT_TASA_VIRAJE_GRADOS_SEG *
          (intervaloMS / 1000) *
          ORBIT_SENTIDO_DERECHA

        const headingBase = Number.isFinite(a.angulo) ? a.angulo : RUMBOS_CIRCUITO.downwind
        a.angulo = (headingBase + deltaAngular + 360) % 360

        const puntoOrbit = puntoPlano(
          { lat: a.lat, lng: a.lng },
          a.angulo,
          distanciaTick
        )

        a.lat = puntoOrbit.lat
        a.lng = puntoOrbit.lng
        a.orbitAcumulado = (a.orbitAcumulado || 0) + Math.abs(deltaAngular)

        if (a.orbitAcumulado >= 360) {
          const continuarOrbitando =
            Boolean(a.orbitModoContinuo) &&
            !Boolean(a.orbitDetenerSolicitado)

          if (continuarOrbitando) {
            a.orbitAcumulado = a.orbitAcumulado % 360
          } else {
            const proyeccionDownwind =
              obtenerProyeccionRutaMasCercana(
                { lat: a.lat, lng: a.lng },
                a.ruta,
                "downwind"
              ) ||
              obtenerProyeccionRutaMasCercana(
                { lat: a.lat, lng: a.lng },
                a.ruta
              )

            if (proyeccionDownwind) {
              a.indice = proyeccionDownwind.indiceA
              a.progreso = proyeccionDownwind.progreso

              if (proyeccionDownwind.puntoIntercepto) {
                const distanciaReingreso = distanciaEntre(
                  { lat: a.lat, lng: a.lng },
                  proyeccionDownwind.puntoIntercepto
                )

                // Evita teletransporte visible cuando sale de ORBIT.
                if (distanciaReingreso <= TOLERANCIA_REINGRESO_ORBITA_M) {
                  a.lat = proyeccionDownwind.puntoIntercepto.lat
                  a.lng = proyeccionDownwind.puntoIntercepto.lng
                }
              }
            }

            a.estado = "CIRCUIT"
            if (!Number.isFinite(a.angulo)) {
              a.angulo = RUMBOS_CIRCUITO.downwind
            }
            limpiarOrbitacionAeronave(a)
          }
        }

        io.to(nombreSala).emit("actualizarAeronave", {
          id: a.id,
          lat: a.lat,
          lng: a.lng,
          altitud: a.altitud,
          angulo: a.angulo,
          velocidad: a.velocidad,
          velocidadObjetivo: a.velocidadObjetivo,
          estado: a.estado
        })

        return
      }

      const siguienteSegmentoActual =
        (a.indice - 1 + a.ruta.length) % a.ruta.length
      const AActual = a.ruta[a.indice]
      const BActual = a.ruta[siguienteSegmentoActual]
      const rumboSegmentoActual = calcularRumboServidor(AActual, BActual)
      const tipoSegmentoActual = obtenerTipoSegmentoRuta(
        AActual,
        BActual,
        rumboSegmentoActual
      )
      const downwindValidoOrbit = esDownwindValidoParaOrbit(
        tipoSegmentoActual,
        rumboSegmentoActual,
        a.angulo
      )

      if (
        a.orbitPendiente &&
        downwindValidoOrbit
      ) {
        const rumboBase =
          typeof a.angulo === "number" ? a.angulo : rumboSegmentoActual
        const deltaAngularEntrada =
          ORBIT_TASA_VIRAJE_GRADOS_SEG *
          (intervaloMS / 1000) *
          ORBIT_SENTIDO_DERECHA

        a.orbitEnCurso = true
        a.orbitPendiente = false
        a.orbitDetenerSolicitado = false
        a.estado = "ORBT"
        a.angulo = (rumboBase + deltaAngularEntrada + 360) % 360
        a.orbitCentro = null
        a.orbitRadio = null
        a.orbitBearing = null
        a.orbitAcumulado = 0

        io.to(nombreSala).emit("actualizarAeronave", {
          id: a.id,
          lat: a.lat,
          lng: a.lng,
          altitud: a.altitud,
          angulo: a.angulo,
          velocidad: a.velocidad,
          velocidadObjetivo: a.velocidadObjetivo,
          estado: a.estado
        })

        return
      }

      let distanciaRestanteTick = distanciaTick

      while (distanciaRestanteTick > 0) {

        const siguiente =
          (a.indice - 1 + a.ruta.length) % a.ruta.length

        const A = a.ruta[a.indice]
        const B = a.ruta[siguiente]

        const distanciaSegmento = distanciaEntre(A, B)
        const restanteSegmento = distanciaSegmento - a.progreso

        if (distanciaRestanteTick < restanteSegmento) {

          a.progreso += distanciaRestanteTick
          distanciaRestanteTick = 0

        } else {

          distanciaRestanteTick -= restanteSegmento
          a.indice = siguiente
          a.progreso = 0
          continue
        }
      }

      const siguiente =
        (a.indice - 1 + a.ruta.length) % a.ruta.length

      const A = a.ruta[a.indice]
      const B = a.ruta[siguiente]

      const distanciaSegmento = distanciaEntre(A, B)

      const t = distanciaSegmento === 0
        ? 0
        : a.progreso / distanciaSegmento

      a.lat = A.lat + (B.lat - A.lat) * t
      a.lng = A.lng + (B.lng - A.lng) * t

      const rumboDeseado = calcularRumboServidor(A, B)

      if (a.angulo === undefined || a.angulo === null) {
        a.angulo = rumboDeseado
      } else {

        const diff = diferenciaAngular(a.angulo, rumboDeseado)
        const maxGiro = 3

        if (Math.abs(diff) < maxGiro) {
          a.angulo = rumboDeseado
        } else {
          a.angulo += Math.sign(diff) * maxGiro
        }

        a.angulo = (a.angulo + 360) % 360
      }

      io.to(nombreSala).emit("actualizarAeronave", {
        id: a.id,
        lat: a.lat,
        lng: a.lng,
        altitud: a.altitud,
        angulo: a.angulo,
        velocidad: a.velocidad,
        velocidadObjetivo: a.velocidadObjetivo,
        estado: a.estado
      })

    })

  }, 50)
}
function distanciaEntre(A, B){

  const R = 6371000
  const dLat = (B.lat - A.lat) * Math.PI/180
  const dLon = (B.lng - A.lng) * Math.PI/180

  const lat1 = A.lat * Math.PI/180
  const lat2 = B.lat * Math.PI/180

  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(lat1)*Math.cos(lat2) *
    Math.sin(dLon/2)**2

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))

  return R * c
}
function puntoPlano(origen, rumbo, distancia){

  const R = 6371000
  const brng = rumbo * Math.PI/180

  const lat1 = origen.lat * Math.PI/180
  const lon1 = origen.lng * Math.PI/180

  const lat2 = Math.asin(
    Math.sin(lat1)*Math.cos(distancia/R) +
    Math.cos(lat1)*Math.sin(distancia/R)*Math.cos(brng)
  )

  const lon2 = lon1 + Math.atan2(
    Math.sin(brng)*Math.sin(distancia/R)*Math.cos(lat1),
    Math.cos(distancia/R)-Math.sin(lat1)*Math.sin(lat2)
  )

  return {
    lat: lat2 * 180/Math.PI,
    lng: lon2 * 180/Math.PI
  }
}

function generarRutaServidor(sala){

  const umbral04 = { lat: -13.755327, lng: -76.229306 }
  const umbral22 = { lat: -13.736552242088443, lng: -76.21347536723357 }

  const rumboPista = 40
  const rumboInverso = 220
  const rumboIzq = 130   // tráfico izquierdo RWY 22

  const lateralM = 1.5 * 1852

  
  const extensionBase = 2.0 * 1852
  const extensionGeneral = sala.extensionExtra || 0
  const extensionDownwindExtra =
    typeof sala.extensionDownwindExtra === "number"
      ? sala.extensionDownwindExtra
      : extensionGeneral
  const extensionUpwindExtra =
    typeof sala.extensionUpwindExtra === "number"
      ? sala.extensionUpwindExtra
      : extensionGeneral

  const extensionDownwindM = extensionBase + extensionDownwindExtra
  const extensionUpwindM = extensionBase + extensionUpwindExtra

  const finalExt = puntoPlano(umbral22, rumboPista, extensionDownwindM)
  const salidaExt = puntoPlano(umbral04, rumboInverso, extensionUpwindM)

  // Patrón "rectangular con lados semicirculares" (tipo racetrack)
  const separacionPiernasM = lateralM * 2
  const salidaExtIzq = puntoPlano(salidaExt, rumboIzq, separacionPiernasM)
  const finalExtIzq = puntoPlano(finalExt, rumboIzq, separacionPiernasM)

  const centroVirajeSalida = puntoPlano(salidaExt, rumboIzq, lateralM)
  const centroVirajeFinal = puntoPlano(finalExt, rumboIzq, lateralM)

  const distanciaRectaM = distanciaEntre(finalExt, salidaExt)
  const longitudSemicirculoM = Math.PI * lateralM
  const separacionObjetivoM = 70

  const pasosRecta = Math.max(20, Math.round(distanciaRectaM / separacionObjetivoM))
  const pasosSemicirculo = Math.max(
    36,
    Math.round(longitudSemicirculoM / separacionObjetivoM)
  )

  const puntos = []

  function registrarPunto(punto, tramoDesdeAnterior = null) {
    if (puntos.length > 0 && tramoDesdeAnterior) {
      puntos[puntos.length - 1].tramo = tramoDesdeAnterior
    }

    puntos.push({
      lat: punto.lat,
      lng: punto.lng,
      tramo: null
    })
  }

  function agregarRecta(
    A,
    B,
    pasos,
    incluirInicio = false,
    tipoTramo = "upwind"
  ) {
    const distancia = distanciaEntre(A, B)
    const rumbo = calcularRumboServidor(A, B)
    const inicio = incluirInicio ? 0 : 1

    for (let i = inicio; i <= pasos; i++) {
      const t = i / pasos
      const punto = puntoPlano(A, rumbo, distancia * t)
      const tipoTramoSegmento =
        typeof tipoTramo === "function"
          ? tipoTramo({
              distanciaRecorrida: distancia * t,
              distanciaTotal: distancia,
              indicePaso: i,
              pasosTotales: pasos
            })
          : tipoTramo
      const tramoDesdeAnterior = i === 0 ? null : tipoTramoSegmento
      registrarPunto(punto, tramoDesdeAnterior)
    }
  }

  function agregarSemicirculo(
    centro,
    radialInicio,
    radialFin,
    pasos,
    tipoTramo,
    incluirFin = true
  ) {
    const limite = incluirFin ? pasos : (pasos - 1)

    for (let i = 1; i <= limite; i++) {
      const t = i / pasos
      const radial = interpolarRumbo(radialInicio, radialFin, t)
      const punto = puntoPlano(centro, radial, lateralM)
      registrarPunto(punto, tipoTramo)
    }
  }

  // 1) Recta de eje pista: FINAL hasta umbral22 y luego UPWIND.
  agregarRecta(
    finalExt,
    salidaExt,
    pasosRecta,
    true,
    ({ distanciaRecorrida }) =>
      distanciaRecorrida <= extensionDownwindM ? "final" : "upwind"
  )

  // 2) Lado semicircular de salida: tramo crosswind
  agregarSemicirculo(centroVirajeSalida, 310, 130, pasosSemicirculo, "crosswind")

  // 3) Downwind (040): salidaExtIzq -> finalExtIzq
  agregarRecta(salidaExtIzq, finalExtIzq, pasosRecta, false, "downwind")

  // 4) Lado semicircular de final: tramo base
  // No agregamos el último punto para evitar duplicar el inicio exacto.
  agregarSemicirculo(
    centroVirajeFinal,
    130,
    310,
    pasosSemicirculo,
    "base",
    false
  )

  if (puntos.length > 1) {
    // Segmento de cierre (último -> primero) también pertenece al tramo base.
    puntos[puntos.length - 1].tramo = "base"
  }

  return puntos.reverse()
}

function obtenerExtensionesBaseSala(sala) {
  const extensionGeneral =
    typeof sala?.extensionExtra === "number" ? sala.extensionExtra : 0

  const extensionUpwindBase =
    typeof sala?.extensionUpwindExtra === "number"
      ? sala.extensionUpwindExtra
      : extensionGeneral

  const extensionDownwindBase =
    typeof sala?.extensionDownwindExtra === "number"
      ? sala.extensionDownwindExtra
      : extensionGeneral

  return {
    upwind: extensionUpwindBase,
    downwind: extensionDownwindBase
  }
}

function tieneExtensionLocalAeronave(aeronave) {
  if (!aeronave) return false

  const extraUpwind =
    typeof aeronave.extensionUpwindExtraLocal === "number"
      ? aeronave.extensionUpwindExtraLocal
      : 0

  const extraDownwind =
    typeof aeronave.extensionDownwindExtraLocal === "number"
      ? aeronave.extensionDownwindExtraLocal
      : 0

  return extraUpwind !== 0 || extraDownwind !== 0
}

function generarRutaServidorParaAeronave(sala, aeronave) {
  if (!sala) return []

  const base = obtenerExtensionesBaseSala(sala)

  const extraUpwindAeronave =
    typeof aeronave?.extensionUpwindExtraLocal === "number"
      ? aeronave.extensionUpwindExtraLocal
      : 0

  const extraDownwindAeronave =
    typeof aeronave?.extensionDownwindExtraLocal === "number"
      ? aeronave.extensionDownwindExtraLocal
      : 0

  return generarRutaServidor({
    ...sala,
    extensionUpwindExtra: base.upwind + extraUpwindAeronave,
    extensionDownwindExtra: base.downwind + extraDownwindAeronave
  })
}

function clasificarTramoPorRumbo(rumbo) {
  const candidatos = [
    { tipo: "upwind", rumbo: RUMBOS_CIRCUITO.upwind },
    { tipo: "downwind", rumbo: RUMBOS_CIRCUITO.downwind },
    { tipo: "crosswind", rumbo: RUMBOS_CIRCUITO.crosswind },
    { tipo: "base", rumbo: RUMBOS_CIRCUITO.base }
  ]

  let mejor = { tipo: "otro", diff: Infinity }

  candidatos.forEach(c => {
    const diff = Math.abs(diferenciaAngular(rumbo, c.rumbo))
    if (diff < mejor.diff) {
      mejor = { tipo: c.tipo, diff }
    }
  })

  return mejor.diff <= 55 ? mejor.tipo : "otro"
}

function obtenerTipoSegmentoRuta(A, B, rumboSegmento = null) {
  if (A && typeof A.tramo === "string" && A.tramo.length > 0) {
    return A.tramo
  }

  const rumbo =
    typeof rumboSegmento === "number"
      ? rumboSegmento
      : calcularRumboServidor(A, B)

  return clasificarTramoPorRumbo(rumbo)
}

function obtenerTramoActualAeronave(aeronave) {
  if (!aeronave || !aeronave.ruta || aeronave.ruta.length < 2) {
    return {
      tipo: clasificarTramoPorRumbo(aeronave?.angulo || 0),
      rumbo: aeronave?.angulo || 0,
      indiceA: null,
      puntoIntercepto: null
    }
  }

  const indiceActual =
    typeof aeronave.indice === "number" ? aeronave.indice : 0

  const indiceA =
    ((indiceActual % aeronave.ruta.length) + aeronave.ruta.length) % aeronave.ruta.length

  const indiceB = (indiceA - 1 + aeronave.ruta.length) % aeronave.ruta.length

  const A = aeronave.ruta[indiceA]
  const B = aeronave.ruta[indiceB]
  const rumbo = calcularRumboServidor(A, B)
  const tipo = obtenerTipoSegmentoRuta(A, B, rumbo)

  return {
    tipo,
    rumbo,
    indiceA,
    A,
    B
  }
}

function esDownwindValidoParaOrbit(tipoTramo, rumboSegmento, anguloActual) {
  if (tipoTramo !== "downwind") return false

  const rumboReferencia =
    typeof anguloActual === "number" ? anguloActual : rumboSegmento

  const diffDownwind = Math.abs(
    diferenciaAngular(rumboReferencia, RUMBOS_CIRCUITO.downwind)
  )

  // Solo consideramos downwind "real" cuando el rumbo estÃ¡ cercano a 040
  return diffDownwind <= 22
}

function buscarInterceptoPorTipo(ruta, tipoObjetivo, posicionActual) {
  if (!ruta || ruta.length < 2) return null

  let mejor = null

  for (let i = 0; i < ruta.length; i++) {
    const A = ruta[i]
    const B = ruta[(i - 1 + ruta.length) % ruta.length]
    const rumbo = calcularRumboServidor(A, B)
    const tipo = obtenerTipoSegmentoRuta(A, B, rumbo)
    if (tipo !== tipoObjetivo) continue

    const punto = proyectarSobreSegmento(posicionActual, A, B)
    const distancia = distanciaEntre(posicionActual, punto)

    if (!mejor || distancia < mejor.distancia) {
      mejor = {
        distancia,
        indiceA: i,
        puntoIntercepto: punto
      }
    }
  }

  return mejor
}

function obtenerProyeccionRutaMasCercana(posicion, ruta, tipoObjetivo = null) {
  if (!ruta || ruta.length < 2) return null

  let mejor = null

  for (let i = 0; i < ruta.length; i++) {
    const A = ruta[i]
    const B = ruta[(i - 1 + ruta.length) % ruta.length]
    const rumboSegmento = calcularRumboServidor(A, B)
    const tipoSegmento = obtenerTipoSegmentoRuta(A, B, rumboSegmento)

    if (tipoObjetivo && tipoSegmento !== tipoObjetivo) {
      continue
    }

    const proyeccion = proyectarSobreSegmentoConFactor(posicion, A, B)
    const distancia = distanciaEntre(posicion, proyeccion.punto)
    const distanciaSegmento = distanciaEntre(A, B)

    if (!mejor || distancia < mejor.distancia) {
      mejor = {
        distancia,
        indiceA: i,
        progreso: distanciaSegmento * proyeccion.t,
        puntoIntercepto: proyeccion.punto
      }
    }
  }

  return mejor
}

function clasificarIngresoDownwindLado(posicion, joinPoint, rumboDownwind) {
  if (!posicion || !joinPoint || typeof rumboDownwind !== "number") {
    return "EAST"
  }

  const referenciaEste = puntoPlano(joinPoint, (rumboDownwind + 90) % 360, 500)
  const referenciaOeste = puntoPlano(joinPoint, (rumboDownwind + 270) % 360, 500)
  const distanciaEste = distanciaEntre(posicion, referenciaEste)
  const distanciaOeste = distanciaEntre(posicion, referenciaOeste)

  return distanciaEste <= distanciaOeste ? "EAST" : "WEST"
}

function construirIngresoDownwind45(aeronave) {
  if (!aeronave || !aeronave.ruta || aeronave.ruta.length < 2) return null

  const posicionActual = { lat: aeronave.lat, lng: aeronave.lng }
  const proyeccionDownwind = obtenerProyeccionRutaMasCercana(
    posicionActual,
    aeronave.ruta,
    "downwind"
  )

  if (!proyeccionDownwind) return null

  const indiceDownwind = proyeccionDownwind.indiceA
  const A = aeronave.ruta[indiceDownwind]
  const B = aeronave.ruta[(indiceDownwind - 1 + aeronave.ruta.length) % aeronave.ruta.length]
  if (!A || !B) return null

  const rumboDownwind = calcularRumboServidor(A, B)
  const distanciaSegmento = Math.max(1, distanciaEntre(A, B))
  const tProyeccion = Math.max(
    0,
    Math.min(1, (proyeccionDownwind.progreso || 0) / distanciaSegmento)
  )
  const tJoin = Math.max(
    INGRESO_DOWNWIND_MIN_T,
    Math.min(INGRESO_DOWNWIND_MAX_T, tProyeccion)
  )
  const latMinDownwind = Math.min(A.lat, B.lat)
  const vieneDelSur = posicionActual.lat < latMinDownwind

  const joinPoint = vieneDelSur
    ? {
        // Ingreso desde el sur: unirse exactamente al inicio de downwind.
        lat: A.lat,
        lng: A.lng
      }
    : {
        lat: A.lat + (B.lat - A.lat) * tJoin,
        lng: A.lng + (B.lng - A.lng) * tJoin
      }

  const ladoIngreso = vieneDelSur
    ? "SOUTH"
    : clasificarIngresoDownwindLado(
        posicionActual,
        joinPoint,
        rumboDownwind
      )

  const waypoints = []

  if (ladoIngreso === "SOUTH") {
    waypoints.push(joinPoint)
  } else {
    const rumboIngreso45 =
      (rumboDownwind - INGRESO_DOWNWIND_ANGULO_GRADOS + 360) % 360
    const preEntryPoint = puntoPlano(
      joinPoint,
      (rumboIngreso45 + 180) % 360,
      INGRESO_DOWNWIND_PREENTRY_M
    )

    if (ladoIngreso === "WEST") {
      // Entrada en gota: cruza downwind hacia el lado este y luego abre la gota.
      const puntoCruce = puntoPlano(
        joinPoint,
        (rumboDownwind + 90) % 360,
        INGRESO_DOWNWIND_CRUCE_M
      )
      const puntoGota = puntoPlano(
        puntoCruce,
        (rumboDownwind + 180) % 360,
        INGRESO_DOWNWIND_GOTA_M
      )
      waypoints.push(puntoCruce, puntoGota)
    }

    // Tramo final de ingreso a 45° sobre downwind.
    waypoints.push(preEntryPoint, joinPoint)
  }

  const waypointsFiltrados = []
  let referencia = posicionActual

  waypoints.forEach(wp => {
    if (distanciaEntre(referencia, wp) >= INGRESO_DOWNWIND_MIN_SEPARACION_WP_M) {
      waypointsFiltrados.push(wp)
      referencia = wp
    }
  })

  if (waypointsFiltrados.length === 0) {
    waypointsFiltrados.push(joinPoint)
  }

  return {
    tramoObjetivo: indiceDownwind,
    waypoints: waypointsFiltrados,
    tipo:
      ladoIngreso === "SOUTH"
        ? "DOWNWIND_SOUTH_START"
        : (
          ladoIngreso === "WEST"
            ? "DOWNWIND_TEARDROP_45"
            : "DOWNWIND_DIRECT_45"
        )
  }
}

function reajustarAeronaveEnRuta(aeronave, rutaNueva) {
  if (!aeronave || !rutaNueva || rutaNueva.length < 2) return

  const mejor = obtenerProyeccionRutaMasCercana(
    { lat: aeronave.lat, lng: aeronave.lng },
    rutaNueva
  )

  aeronave.ruta = rutaNueva
  aeronave.indice = mejor ? mejor.indiceA : 0
  aeronave.progreso = mejor ? mejor.progreso : 0
}

function regenerarRutaSala(nombreSala) {
  const sala = salas[nombreSala]
  if (!sala) return null

  const rutaBase = generarRutaServidor(sala)

  sala.aeronaves.forEach(a => {
    const rutaAeronave = tieneExtensionLocalAeronave(a)
      ? generarRutaServidorParaAeronave(sala, a)
      : rutaBase

    if (a.estado === "CIRCUIT") {
      reajustarAeronaveEnRuta(a, rutaAeronave)
      return
    }

    if (
      (a.estado === "INTERCEPTING ARC" || a.estado === "INTERCEPTING LEG") &&
      a.ruta
    ) {
      a.ruta = rutaAeronave

      if (typeof a.tramoObjetivo === "number") {
        a.tramoObjetivo =
          ((a.tramoObjetivo % rutaAeronave.length) + rutaAeronave.length) %
          rutaAeronave.length

        const A = rutaAeronave[a.tramoObjetivo]
        const B = rutaAeronave[(a.tramoObjetivo - 1 + rutaAeronave.length) % rutaAeronave.length]
        a.puntoIntercepto = proyectarSobreSegmento(
          { lat: a.lat, lng: a.lng },
          A,
          B
        )
      }
    }
  })

  return rutaBase
}

function proyectarSobreSegmento(P, A, B){
  return proyectarSobreSegmentoConFactor(P, A, B).punto
}

function proyectarSobreSegmentoConFactor(P, A, B){

  const APx = P.lat - A.lat;
  const APy = P.lng - A.lng;

  const ABx = B.lat - A.lat;
  const ABy = B.lng - A.lng;

  const ab2 = ABx*ABx + ABy*ABy;
  const ap_ab = APx*ABx + APy*ABy;

  let t = 0
  if (ab2 > 0) {
    t = ap_ab / ab2;
  }

  t = Math.max(0, Math.min(1, t));

  return {
    punto: {
      lat: A.lat + ABx * t,
      lng: A.lng + ABy * t
    },
    t
  };
}


function diferenciaAngular(actual, destino) {
  return (destino - actual + 540) % 360 - 180
}

function interpolarRumbo(actual, destino, factor) {
  const factorSeguro = Math.max(0, Math.min(1, factor))
  const diff = diferenciaAngular(actual, destino)
  return (actual + diff * factorSeguro + 360) % 360
}

function calcularRumboServidor(A, B){

  const lat1 = A.lat * Math.PI/180
  const lat2 = B.lat * Math.PI/180
  const dLon = (B.lng - A.lng) * Math.PI/180

  const y = Math.sin(dLon) * Math.cos(lat2)
  const x =
    Math.cos(lat1)*Math.sin(lat2) -
    Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon)

  const brng = Math.atan2(y,x) * 180/Math.PI

  return (brng + 360) % 360
}

function limpiarGoAroundAeronave(aeronave) {
  if (!aeronave) return
  aeronave.goAroundActivo = false
  aeronave.goAroundFase = null
  aeronave.goAroundLastDist = null
}

function inicializarGoAroundAeronave(aeronave) {
  if (!aeronave) return
  aeronave.goAroundActivo = true
  aeronave.goAroundFase = "TO_FINAL"
  aeronave.goAroundLastDist = null
}

function emitirActualizacionAeronave(nombreSala, aeronave) {
  io.to(nombreSala).emit("actualizarAeronave", {
    id: aeronave.id,
    lat: aeronave.lat,
    lng: aeronave.lng,
    altitud: aeronave.altitud,
    angulo: aeronave.angulo,
    velocidad: aeronave.velocidad,
    velocidadObjetivo: aeronave.velocidadObjetivo,
    estado: aeronave.estado
  })
}

function prepararAeronaveParaCircuito(salaNombre, sala, aeronave, opciones = {}) {
  if (!salaNombre || !sala || !aeronave) return false

  limpiarOrbitacionAeronave(aeronave)
  aeronave.altitudCircuitoAutomaticaActiva = true

  aeronave.ruta = generarRutaServidorParaAeronave(sala, aeronave)

  io.to(salaNombre).emit("rutaCircuito", {
    ruta: aeronave.ruta
  })

  let usarIngresoMasCercano = opciones && opciones.modoIngreso === "nearest"
  if (!usarIngresoMasCercano && opciones && opciones.modoIngreso === "nearest-if-close") {
    const proyeccionCercana = obtenerProyeccionRutaMasCercana(
      { lat: aeronave.lat, lng: aeronave.lng },
      aeronave.ruta
    )
    usarIngresoMasCercano =
      Boolean(proyeccionCercana) &&
      Number.isFinite(proyeccionCercana.distancia) &&
      proyeccionCercana.distancia < INGRESO_CERCANO_MAX_DISTANCIA_M
  }
  const ingresoDownwind = usarIngresoMasCercano
    ? null
    : construirIngresoDownwind45(aeronave)
  if (
    ingresoDownwind &&
    Array.isArray(ingresoDownwind.waypoints) &&
    ingresoDownwind.waypoints.length > 0
  ) {
    aeronave.tramoObjetivo = ingresoDownwind.tramoObjetivo
    aeronave.ingresoDownwindWaypoints = ingresoDownwind.waypoints.map(wp => ({
      lat: wp.lat,
      lng: wp.lng
    }))
    aeronave.ingresoDownwindTipo = ingresoDownwind.tipo
    aeronave.puntoIntercepto = aeronave.ingresoDownwindWaypoints[0]
    aeronave.estado = "INTERCEPTING ARC"
    aeronave.interceptTicks = 0
    aeronave.interceptHeadingRef = null
    aeronave.velocidad = GO_AROUND_SPEED_DEFAULT_KT * 0.514444
    aeronave.velocidadObjetivo = GO_AROUND_SPEED_DEFAULT_KT

    iniciarMotorSala(salaNombre)
    return true
  }

  aeronave.ingresoDownwindWaypoints = null
  aeronave.ingresoDownwindTipo = null

  let mejor = {
    distancia: Infinity,
    indiceA: 0,
    puntoIntercepto: null
  }

  for (let i = 0; i < aeronave.ruta.length; i++) {
    const A = aeronave.ruta[i]
    const B = aeronave.ruta[(i - 1 + aeronave.ruta.length) % aeronave.ruta.length]

    const punto = proyectarSobreSegmento(
      { lat: aeronave.lat, lng: aeronave.lng },
      A,
      B
    )

    const d = distanciaEntre(
      { lat: aeronave.lat, lng: aeronave.lng },
      punto
    )

    if (d < mejor.distancia) {
      mejor = {
        distancia: d,
        indiceA: i,
        puntoIntercepto: punto
      }
    }
  }

  aeronave.tramoObjetivo = mejor.indiceA
  aeronave.puntoIntercepto = mejor.puntoIntercepto
  aeronave.estado = "INTERCEPTING ARC"
  aeronave.interceptTicks = 0
  aeronave.interceptHeadingRef = null
  aeronave.velocidad = GO_AROUND_SPEED_DEFAULT_KT * 0.514444
  aeronave.velocidadObjetivo = GO_AROUND_SPEED_DEFAULT_KT

  iniciarMotorSala(salaNombre)
  return true
}

function procesarGoAroundEnMotor(aeronave, intervaloMS, nombreSala) {
  if (!aeronave || !aeronave.goAroundActivo) return false

  if (aeronave.goAroundFase === "TO_FINAL") {
    const enCircuito =
      aeronave.estado === "CIRCUIT" ||
      aeronave.estado === "INTERCEPTING ARC" ||
      aeronave.estado === "INTERCEPTING LEG" ||
      aeronave.estado === "ORBT"

    if (!enCircuito) return false

    const rumboActual =
      typeof aeronave.angulo === "number" ? aeronave.angulo : GO_AROUND_TRIGGER_HEADING
    const headingOk =
      Math.abs(diferenciaAngular(rumboActual, GO_AROUND_TRIGGER_HEADING)) <=
      GO_AROUND_TRIGGER_HEADING_TOL

    const distanciaPunto = distanciaEntre(
      { lat: aeronave.lat, lng: aeronave.lng },
      GO_AROUND_TRIGGER_POINT
    )

    const distanciaPrevia =
      typeof aeronave.goAroundLastDist === "number"
        ? aeronave.goAroundLastDist
        : null
    aeronave.goAroundLastDist = distanciaPunto

    const cruzoPunto =
      distanciaPunto <= GO_AROUND_TRIGGER_DISTANCE_M ||
      (
        typeof distanciaPrevia === "number" &&
        distanciaPrevia > GO_AROUND_TRIGGER_DISTANCE_M &&
        distanciaPunto <= GO_AROUND_TRIGGER_DISTANCE_M
      )

    if (!(headingOk && cruzoPunto)) {
      return false
    }

    aeronave.goAroundFase = "TO_RADIAL"
    aeronave.estado = "GO AROUND"
    limpiarOrbitacionAeronave(aeronave)
    aeronave.ruta = null
    aeronave.indice = 0
    aeronave.progreso = 0
    aeronave.tramoObjetivo = null
    aeronave.puntoIntercepto = null

    if (
      !Number.isFinite(aeronave.velocidadObjetivo) ||
      aeronave.velocidadObjetivo <= 0
    ) {
      aeronave.velocidadObjetivo = GO_AROUND_SPEED_DEFAULT_KT
    }
  }

  if (
    aeronave.goAroundFase !== "TO_RADIAL" &&
    aeronave.goAroundFase !== "ON_RADIAL"
  ) {
    return false
  }

  const velocidadObjetivoKt =
    (Number.isFinite(aeronave.velocidadObjetivo) && aeronave.velocidadObjetivo > 0)
      ? aeronave.velocidadObjetivo
      : GO_AROUND_SPEED_DEFAULT_KT
  const velocidadMPS = velocidadObjetivoKt * 0.514444
  const distanciaTick = velocidadMPS * (intervaloMS / 1000)

  let headingObjetivo = GO_AROUND_TRIGGER_HEADING
  const radialActual = calcularRumboServidor(
    SCO_VOR_COORDS,
    { lat: aeronave.lat, lng: aeronave.lng }
  )

  if (aeronave.goAroundFase === "TO_RADIAL") {
    const errorRadial = diferenciaAngular(radialActual, GO_AROUND_RADIAL_OBJETIVO)
    if (Math.abs(errorRadial) <= GO_AROUND_INTERCEPT_TOL) {
      aeronave.goAroundFase = "ON_RADIAL"
    }
  }

  if (aeronave.goAroundFase === "ON_RADIAL") {
    const errorRadial = diferenciaAngular(radialActual, GO_AROUND_RADIAL_OBJETIVO)
    const correccion = Math.max(-12, Math.min(12, errorRadial * 1.5))
    headingObjetivo = (GO_AROUND_RADIAL_OBJETIVO + correccion + 360) % 360

    const ascensoPorTick =
      (GO_AROUND_CLIMB_RATE_FPM / 60) * (intervaloMS / 1000)
    const altitudActual = Number.isFinite(aeronave.altitud) ? aeronave.altitud : 0
    if (altitudActual < GO_AROUND_CLIMB_TARGET_FT) {
      aeronave.altitud = Math.min(
        GO_AROUND_CLIMB_TARGET_FT,
        altitudActual + ascensoPorTick
      )
    } else {
      aeronave.altitud = altitudActual
    }
  }

  if (!Number.isFinite(aeronave.angulo)) {
    aeronave.angulo = headingObjetivo
  } else {
    const maxGiro = 3
    const diff = diferenciaAngular(aeronave.angulo, headingObjetivo)
    if (Math.abs(diff) <= maxGiro) {
      aeronave.angulo = headingObjetivo
    } else {
      aeronave.angulo += Math.sign(diff) * maxGiro
    }
    aeronave.angulo = (aeronave.angulo + 360) % 360
  }

  const nuevoPunto = puntoPlano(
    { lat: aeronave.lat, lng: aeronave.lng },
    aeronave.angulo,
    distanciaTick
  )

  aeronave.lat = nuevoPunto.lat
  aeronave.lng = nuevoPunto.lng
  aeronave.velocidad = velocidadMPS
  aeronave.velocidadObjetivo = velocidadObjetivoKt

  if (aeronave.goAroundFase === "ON_RADIAL") {
    const distanciaVorM = distanciaEntre(
      SCO_VOR_COORDS,
      { lat: aeronave.lat, lng: aeronave.lng }
    )
    const altitudActual = Number.isFinite(aeronave.altitud) ? aeronave.altitud : 0

    if (
      distanciaVorM >= GO_AROUND_MANUAL_SWITCH_DISTANCE_M &&
      altitudActual >= GO_AROUND_CLIMB_TARGET_FT
    ) {
      limpiarGoAroundAeronave(aeronave)
      aeronave.estado = "MANUAL"
      aeronave.ruta = null
      aeronave.indice = 0
      aeronave.progreso = 0
      aeronave.tramoObjetivo = null
      aeronave.puntoIntercepto = null

      emitirActualizacionAeronave(nombreSala, aeronave)
      return true
    }
  }

  aeronave.estado = "GO AROUND"

  emitirActualizacionAeronave(nombreSala, aeronave)
  return true
}




// ================== SOCKET ==================

io.on("connection", (socket) => {

  console.log("Nuevo usuario:", socket.id);

  socket.emit("listaSalas", obtenerListaSalas());

  // ===== CREAR SALA =====
  socket.on("crearSala", ({ nombre, horaInicial }) => {

    if (salas[nombre]) return;

    const segundosIniciales = horaInicial
      ? convertirHoraASegundos(horaInicial)
      : 0;

    salas[nombre] = {
      jugadores: [],
      aeronaves: [],
      extensionExtra: 0,
      extensionUpwindExtra: 0,
      extensionDownwindExtra: 0
    };

relojesSalas[nombre] = {
  tiempoBase: segundosIniciales,
  timestampBase: Date.now(),
  velocidad: 1,
  pausado: false,
};



    iniciarRelojSala(nombre);

    io.emit("listaSalas", obtenerListaSalas());
  });

socket.on("cambiarHora", ({ hora }) => {

  const sala = socket.sala;
  if (!sala) return;

  const reloj = relojesSalas[sala];
  if (!reloj) return;

  const segundos = convertirHoraASegundos(hora);

  reloj.tiempoBase = segundos;
  reloj.timestampBase = Date.now();

  io.to(sala).emit("horaSala", formatearHora(segundos));
});

  // ===== UNIRSE A SALA =====
  socket.on("unirseSala", (nombre) => {

    if (!salas[nombre]) return;

    socket.join(nombre);
    socket.sala = nombre;

    if (!salas[nombre].jugadores.includes(socket.id)) {
      salas[nombre].jugadores.push(socket.id);
    }
if (timeoutsSalas[nombre]) {
  clearTimeout(timeoutsSalas[nombre]);
  delete timeoutsSalas[nombre];
}
    socket.emit("cargarAeronaves", salas[nombre].aeronaves);
if (peligroSalas[nombre]) {
  socket.emit("peligroActivado");
}

    socket.emit("rutaCircuito", {
      ruta: generarRutaServidor(salas[nombre])
    });

    // ðŸ”¥ SINCRONIZAR INMEDIATAMENTE
    const horaActual = obtenerHoraActualSala(nombre);
    if (horaActual) {
      socket.emit("horaSala", horaActual);
    }
    socket.emit("estadoTiempo", {
      pausado: relojesSalas[nombre].pausado
    });

    io.emit("listaSalas", obtenerListaSalas());
  });

socket.on("solicitarRutaCircuito", () => {

  const nombreSala = socket.sala
  if (!nombreSala) return

  const sala = salas[nombreSala]
  if (!sala) return

  socket.emit("rutaCircuito", {
    ruta: generarRutaServidor(sala)
  })
})

socket.on("solicitarSincronizacionTiempo", () => {
  const sala = socket.sala
  if (!sala) return

  const reloj = relojesSalas[sala]
  if (!reloj) return

  const horaActual = obtenerHoraActualSala(sala)
  if (horaActual) {
    socket.emit("horaSala", horaActual)
  }

  socket.emit("estadoTiempo", {
    pausado: reloj.pausado
  })
})

  // ===== CREAR AERONAVE =====
socket.on("crearAeronave", (data) => {

  const sala = socket.sala;
  if (!sala) return;

  salas[sala].aeronaves.push({
  id: data.id,
  owner: socket.id,
  tipo: data.tipo,
  lat: data.lat,
  lng: data.lng,
  altitud: data.altitud || 0,
  angulo: data.angulo || 0,
  velocidad: 0,
  velocidadObjetivo: 0,
  orbitPendiente: false,
  orbitEnCurso: false,
  orbitModoContinuo: false,
  orbitDetenerSolicitado: false,
  altitudCircuitoAutomaticaActiva: false,
  ingresoDownwindWaypoints: null,
  ingresoDownwindTipo: null,
  estado: "IDLE"
});


  io.to(sala).emit("crearAeronave", {
  id: data.id,
  tipo: data.tipo,
  lat: data.lat,
  lng: data.lng,
  altitud: data.altitud || 0,
  angulo: data.angulo || 0,
  estado: "IDLE",
  velocidad: 0,
  velocidadObjetivo: 0,
  orbitPendiente: false,
  orbitEnCurso: false,
  orbitModoContinuo: false,
  orbitDetenerSolicitado: false,
  owner: socket.id
});


});
socket.on("extenderSalida", ({ metros }) => {

  const nombreSala = socket.sala
  if (!nombreSala) return

  const sala = salas[nombreSala]
  if (!sala) return

  const metrosSeguros =
    typeof metros === "number" && Number.isFinite(metros) && metros > 0
      ? metros
      : (0.5 * 1852)

  // ExtensiÃ³n general heredada + por tramo (compatibilidad)
  sala.extensionExtra += metrosSeguros
  sala.extensionUpwindExtra = (sala.extensionUpwindExtra || 0) + metrosSeguros
  sala.extensionDownwindExtra = (sala.extensionDownwindExtra || 0) + metrosSeguros

  // Enviar nueva ruta a todos
  const rutaActualizada = regenerarRutaSala(nombreSala)
  io.to(nombreSala).emit("rutaCircuitoActualizada", {
    extensionExtra: sala.extensionExtra,
    extensionUpwindExtra: sala.extensionUpwindExtra,
    extensionDownwindExtra: sala.extensionDownwindExtra,
    ruta: rutaActualizada
  })

})

socket.on("extenderTramoCircuito", ({ id, metros }) => {

  const nombreSala = socket.sala
  if (!nombreSala) return

  const sala = salas[nombreSala]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (aeronave.owner !== socket.id) return

  const metrosSeguros =
    typeof metros === "number" && Number.isFinite(metros) && metros > 0
      ? metros
      : (0.5 * 1852)

  const tramoActual = obtenerTramoActualAeronave(aeronave)
  let tramoObjetivo = tramoActual.tipo

  if (tramoObjetivo !== "upwind" && tramoObjetivo !== "downwind") {
    const rumboRef =
      typeof tramoActual.rumbo === "number"
        ? tramoActual.rumbo
        : (aeronave.angulo || 0)

    const diffUpwind = Math.abs(
      diferenciaAngular(rumboRef, RUMBOS_CIRCUITO.upwind)
    )
    const diffDownwind = Math.abs(
      diferenciaAngular(rumboRef, RUMBOS_CIRCUITO.downwind)
    )

    tramoObjetivo = diffDownwind < diffUpwind ? "downwind" : "upwind"
  }

  if (tramoObjetivo === "downwind") {
    aeronave.extensionDownwindExtraLocal =
      (aeronave.extensionDownwindExtraLocal || 0) + metrosSeguros
  } else {
    aeronave.extensionUpwindExtraLocal =
      (aeronave.extensionUpwindExtraLocal || 0) + metrosSeguros
  }

  const rumboObjetivo =
    tramoObjetivo === "downwind"
      ? RUMBOS_CIRCUITO.downwind
      : RUMBOS_CIRCUITO.upwind

  const rutaActualizada = generarRutaServidorParaAeronave(sala, aeronave)
  const proyeccionTramo = obtenerProyeccionRutaMasCercana(
    { lat: aeronave.lat, lng: aeronave.lng },
    rutaActualizada,
    tramoObjetivo
  )

  if (aeronave.estado === "CIRCUIT") {
    aeronave.ruta = rutaActualizada

    if (proyeccionTramo) {
      aeronave.indice = proyeccionTramo.indiceA
      aeronave.progreso = proyeccionTramo.progreso
    } else {
      reajustarAeronaveEnRuta(aeronave, rutaActualizada)
    }

    aeronave.angulo = rumboObjetivo
  } else if (
    (aeronave.estado === "INTERCEPTING ARC" || aeronave.estado === "INTERCEPTING LEG") &&
    aeronave.ruta
  ) {
    aeronave.ingresoDownwindWaypoints = null
    aeronave.ingresoDownwindTipo = null
    aeronave.ruta = rutaActualizada

    if (proyeccionTramo) {
      aeronave.tramoObjetivo = proyeccionTramo.indiceA
      aeronave.puntoIntercepto = proyeccionTramo.puntoIntercepto
      aeronave.estado = "INTERCEPTING LEG"
      aeronave.interceptHeadingRef = null
    }

    aeronave.angulo = rumboObjetivo
  } else {
    aeronave.ruta = rutaActualizada
  }

  socket.emit("rutaCircuitoActualizada", {
    id: aeronave.id,
    ruta: rutaActualizada,
    tramoExtendido: tramoObjetivo,
    extensionAeronave: {
      upwind: aeronave.extensionUpwindExtraLocal || 0,
      downwind: aeronave.extensionDownwindExtraLocal || 0
    }
  })
})

socket.on("virarCircuito", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (aeronave.owner !== socket.id) return

  limpiarOrbitacionAeronave(aeronave)
  limpiarGoAroundAeronave(aeronave)

  if (!aeronave.ruta || aeronave.ruta.length < 2) {
    aeronave.ruta = generarRutaServidorParaAeronave(sala, aeronave)
  }

  const tramoActual = obtenerTramoActualAeronave(aeronave)
  const rumboReferencia =
    typeof aeronave.angulo === "number"
      ? aeronave.angulo
      : (typeof tramoActual.rumbo === "number" ? tramoActual.rumbo : 0)

  const diffUpwind = Math.abs(
    diferenciaAngular(rumboReferencia, RUMBOS_CIRCUITO.upwind)
  )
  const diffDownwind = Math.abs(
    diferenciaAngular(rumboReferencia, RUMBOS_CIRCUITO.downwind)
  )

  let tipoObjetivo = null
  if (tramoActual.tipo === "upwind" || diffUpwind <= diffDownwind) {
    tipoObjetivo = "crosswind"
  } else {
    tipoObjetivo = "base"
  }

  const mejor = buscarInterceptoPorTipo(
    aeronave.ruta,
    tipoObjetivo,
    { lat: aeronave.lat, lng: aeronave.lng }
  )

  if (!mejor) return

  aeronave.tramoObjetivo = mejor.indiceA
  aeronave.puntoIntercepto = mejor.puntoIntercepto
  aeronave.ingresoDownwindWaypoints = null
  aeronave.ingresoDownwindTipo = null
  aeronave.estado = "INTERCEPTING ARC"
  aeronave.interceptTicks = 0
  aeronave.interceptHeadingRef = null
  aeronave.velocidad = aeronave.velocidad || (90 * 0.514444)

  iniciarMotorSala(salaNombre)
})

socket.on("orbitarCircuito", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (aeronave.owner !== socket.id) return

  if (
    aeronave.estado !== "CIRCUIT" &&
    aeronave.estado !== "ORBT" &&
    aeronave.estado !== "INTERCEPTING ARC" &&
    aeronave.estado !== "INTERCEPTING LEG"
  ) {
    return
  }

  if (!aeronave.ruta || aeronave.ruta.length < 2) return

  if (aeronave.orbitEnCurso) {
    const activarContinuo = !Boolean(aeronave.orbitModoContinuo)

    if (activarContinuo) {
      aeronave.orbitModoContinuo = true
      aeronave.orbitDetenerSolicitado = false
    } else {
      // Saldrá cuando complete la órbita actual.
      aeronave.orbitModoContinuo = false
      aeronave.orbitDetenerSolicitado = true
    }

    iniciarMotorSala(salaNombre)
    return
  }

  if (Boolean(aeronave.orbitPendiente) || Boolean(aeronave.orbitModoContinuo)) {
    // Si aún no empezó a orbitar, se cancela inmediatamente.
    limpiarOrbitacionAeronave(aeronave)
    iniciarMotorSala(salaNombre)
    return
  }

  limpiarOrbitacionAeronave(aeronave)
  aeronave.orbitModoContinuo = true
  aeronave.orbitDetenerSolicitado = false
  aeronave.orbitPendiente = true
  iniciarMotorSala(salaNombre)
})


  // ===== ACTUALIZAR AERONAVE =====
socket.on("actualizarAeronave", (data) => {

  const sala = socket.sala;
  if (!sala) return;

  const aeronave = salas[sala].aeronaves.find(a => a.id === data.id);
  if (!aeronave) return;

  // ðŸ”’ Solo el dueÃ±o puede actualizar
  if (aeronave.owner !== socket.id) return;

  // ðŸ›¡ ValidaciÃ³n bÃ¡sica de datos
  if (typeof data.lat !== "number") return;
  if (typeof data.lng !== "number") return;
  if (typeof data.altitud !== "number") return;
  if (typeof data.angulo !== "number") return;
  const altitudAnterior = Number.isFinite(aeronave.altitud) ? aeronave.altitud : 0
  const altitudRecibida = Number.isFinite(data.altitud)
    ? data.altitud
    : altitudAnterior
  const estadoRecibido =
    typeof data.estado === "string" ? data.estado : aeronave.estado
  const huboCambioManualAltitud =
    Math.abs(altitudRecibida - altitudAnterior) > EPSILON_ALTITUD_MANUAL_CIRCUITO_FT

  if (
    huboCambioManualAltitud &&
    aeronave.altitudCircuitoAutomaticaActiva &&
    esEstadoCircuitoConAltitudAutomatica(estadoRecibido)
  ) {
    aeronave.altitudCircuitoAutomaticaActiva = false
  }

if(typeof data.estado === "string"){
  aeronave.estado = data.estado
}

  aeronave.lat = data.lat;
  aeronave.lng = data.lng;
  aeronave.altitud = altitudRecibida;
  aeronave.angulo = data.angulo;
  if (typeof data.velocidad === "number" && Number.isFinite(data.velocidad)) {
    aeronave.velocidad = Math.max(0, data.velocidad);
  }
  if (
    typeof data.velocidadObjetivo === "number" &&
    Number.isFinite(data.velocidadObjetivo)
  ) {
    aeronave.velocidadObjetivo = Math.max(0, data.velocidadObjetivo);
  }

  socket.to(sala).emit("actualizarAeronave", {
  id: aeronave.id,
  lat: aeronave.lat,
  lng: aeronave.lng,
  altitud: aeronave.altitud,
  angulo: aeronave.angulo,
  velocidad: aeronave.velocidad,
  velocidadObjetivo: aeronave.velocidadObjetivo,
  estado: aeronave.estado
});


});
socket.on("activarManual", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (aeronave.owner !== socket.id) return

  limpiarOrbitacionAeronave(aeronave)

  if (aeronave.estado === "MANUAL") {

    // DESACTIVAR MANUAL
    aeronave.estado = "AUTO"

  } else {

    // ACTIVAR MANUAL
    aeronave.estado = "MANUAL"

    aeronave.ruta = null
    aeronave.indice = 0
    aeronave.progreso = 0
    aeronave.indiceObjetivo = null

  }

  iniciarMotorSala(salaNombre)

  io.to(salaNombre).emit("actualizarAeronave", {
    id: aeronave.id,
    lat: aeronave.lat,
    lng: aeronave.lng,
    altitud: aeronave.altitud,
    angulo: aeronave.angulo,
    velocidad: aeronave.velocidad,
    velocidadObjetivo: aeronave.velocidadObjetivo,
    estado: aeronave.estado
  })
})
// ===== INICIAR CIRCUITO =====
socket.on("iniciarCircuito", ({ id, modoIngreso } = {}) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return
  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (aeronave.owner !== socket.id) return
  if (
  aeronave.estado === "CIRCUIT" ||
  aeronave.estado === "INTERCEPTING ARC" ||
  aeronave.estado === "INTERCEPTING LEG"
) return

  limpiarGoAroundAeronave(aeronave)
  prepararAeronaveParaCircuito(salaNombre, sala, aeronave, { modoIngreso })
})
socket.on("iniciarGoAround", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (aeronave.owner !== socket.id) return

  inicializarGoAroundAeronave(aeronave)

  const enCircuito =
    aeronave.estado === "CIRCUIT" ||
    aeronave.estado === "INTERCEPTING ARC" ||
    aeronave.estado === "INTERCEPTING LEG" ||
    aeronave.estado === "ORBT"

  if (enCircuito && aeronave.ruta && aeronave.ruta.length >= 2) {
    iniciarMotorSala(salaNombre)
    return
  }

  prepararAeronaveParaCircuito(salaNombre, sala, aeronave)
})
socket.on("detenerCircuito", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (aeronave.owner !== socket.id) return

  limpiarGoAroundAeronave(aeronave)
  aeronave.estado = "IDLE"
  limpiarOrbitacionAeronave(aeronave)
  aeronave.ruta = null
  aeronave.indice = 0
  aeronave.progreso = 0
  aeronave.indiceObjetivo = null

})
socket.on("forzarAterrizaje", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (aeronave.owner !== socket.id) return

  // ðŸ”¥ CANCELAR TODO LO QUE CONTROLE MOVIMIENTO

  limpiarGoAroundAeronave(aeronave)
  limpiarOrbitacionAeronave(aeronave)
  aeronave.ruta = null
  aeronave.indice = 0
  aeronave.progreso = 0
  aeronave.indiceObjetivo = null
  aeronave.puntoIngreso = null

  // ðŸ”¥ CANCELAR MANUAL SI ESTABA ACTIVO
  if (aeronave.estado === "MANUAL") {
    aeronave.velocidad = aeronave.velocidad || (90 * 0.514444)
  }

  // ðŸ”¥ ESTADO DEFINITIVO DE ATERRIZAJE
  aeronave.estado = "LANDING"

  io.to(salaNombre).emit("actualizarAeronave", {
    id: aeronave.id,
    lat: aeronave.lat,
    lng: aeronave.lng,
    altitud: aeronave.altitud,
    angulo: aeronave.angulo,
    velocidad: aeronave.velocidad,
    velocidadObjetivo: aeronave.velocidadObjetivo,
    estado: aeronave.estado
  })

})
  // ===== ELIMINAR AERONAVE =====
  socket.on("eliminarAeronave", (id) => {

    const sala = socket.sala;
    if (!sala) return;

    salas[sala].aeronaves =
      salas[sala].aeronaves.filter(a => a.id !== id);

    io.to(sala).emit("borrarAeronave", id);
  });
socket.on("ajusteManual", ({ id, tipo, valor }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const a = sala.aeronaves.find(av => av.id === id)
  if (!a) return

  if (a.owner !== socket.id) return
  if (a.estado !== "MANUAL" && tipo !== "speed") return

  if (tipo === "heading") {
    a.angulo = (a.angulo + valor + 360) % 360
  }

  if (tipo === "speed") {

  const nudosEnMPS = valor * 0.514444

  const velocidadBase = Number.isFinite(a.velocidad)
    ? a.velocidad
    : (
      Number.isFinite(a.velocidadObjetivo)
        ? a.velocidadObjetivo * 0.514444
        : 0
    )

  a.velocidad = Math.max(
    0,
    velocidadBase + nudosEnMPS
  )
  a.velocidadObjetivo = Math.round(a.velocidad / 0.514444)

}

  if (tipo === "altitude") {
    a.altitud = Math.max(0, a.altitud + valor)
  }

  io.to(salaNombre).emit("actualizarAeronave", {
    id: a.id,
    lat: a.lat,
    lng: a.lng,
    altitud: a.altitud,
    angulo: a.angulo,
    velocidad: a.velocidad,
    velocidadObjetivo: a.velocidadObjetivo,
    estado: a.estado
  })

})
socket.on("setSpeedKnots", ({ id, speedKnots }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const a = sala.aeronaves.find(av => av.id === id)
  if (!a) return

  if (a.owner !== socket.id) return

  if (typeof speedKnots !== "number" || !Number.isFinite(speedKnots)) return

  const speedSafe = Math.max(0, Math.min(SPEED_CONTROL_MAX_KNOTS, speedKnots))
  a.velocidad = speedSafe * 0.514444
  a.velocidadObjetivo = speedSafe

  io.to(salaNombre).emit("actualizarAeronave", {
    id: a.id,
    lat: a.lat,
    lng: a.lng,
    altitud: a.altitud,
    angulo: a.angulo,
    velocidad: a.velocidad,
    velocidadObjetivo: a.velocidadObjetivo,
    estado: a.estado
  })

})
  // ===== CONTROL DEL TIEMPO =====
socket.on("controlTiempo", ({ accion }) => {

  const sala = socket.sala;
  if (!sala) return;

  const reloj = relojesSalas[sala];
  if (!reloj) return;

  if (!reloj.pausado) {
    const ahora = Date.now();
    const velocidadReloj =
      Number.isFinite(reloj.velocidad) && reloj.velocidad > 0
        ? reloj.velocidad
        : 1;
    const delta = (ahora - reloj.timestampBase) / 1000 * velocidadReloj;
    reloj.tiempoBase += delta;
    reloj.timestampBase = ahora;
  }

  if (accion === "pausar") {
    reloj.pausado = true;
  }

  if (accion === "reanudar") {
    reloj.pausado = false;
    reloj.timestampBase = Date.now();
  }

  // Mantener reloj siempre en tiempo real (x1).
  reloj.velocidad = 1;

  // ðŸ”¥ NUEVO
  io.to(sala).emit("estadoTiempo", {
    pausado: reloj.pausado
  });

});

socket.on("desactivarPeligroSala", () => {
  const sala = socket.sala;
  if (!sala) return;
 peligroSalas[sala] = false;
  io.to(sala).emit("peligroDesactivado");
});
const PASSWORD = "0223";

socket.on("activarPeligroSala", ({ clave }) => {

  const sala = socket.sala;
  if (!sala) return;

  if(clave !== PASSWORD){
    socket.emit("errorPeligro", "Incorrect password");
    return;
  }

  if(peligroSalas[sala]) return;

  peligroSalas[sala] = true;

  io.to(sala).emit("peligroActivado");

  setTimeout(() => {
    peligroSalas[sala] = false;
    io.to(sala).emit("peligroDesactivado");
  }, 60000);

});

  // ===== DESCONECTAR =====
socket.on("disconnect", () => {

  for (let nombre in salas) {

    salas[nombre].jugadores =
      salas[nombre].jugadores.filter(id => id !== socket.id);

    // ðŸŸ¡ Si quedÃ³ vacÃ­a, iniciar countdown
    if (salas[nombre].jugadores.length === 0) {

      // Evitar mÃºltiples timeouts
      if (timeoutsSalas[nombre]) return;

      console.log(` Sala ${nombre} vacía Eliminando en 30 minutos si nadie entra.`);

      timeoutsSalas[nombre] = setTimeout(() => {

        // Verificar nuevamente antes de borrar
        if (salas[nombre] && salas[nombre].jugadores.length === 0) {

          console.log(`Eliminando sala ${nombre} por inactividad.`);

          if (intervalosSalas[nombre]) {
            clearInterval(intervalosSalas[nombre]);
            delete intervalosSalas[nombre];
          }
if (motoresSalas[nombre]) {
  clearInterval(motoresSalas[nombre])
  delete motoresSalas[nombre]
}
          delete salas[nombre];
          delete relojesSalas[nombre];
          delete peligroSalas[nombre];
          delete timeoutsSalas[nombre];

          io.emit("listaSalas", obtenerListaSalas());
        }

      }, 30 * 60 * 1000); // 30 minutos
    }
  }

  io.emit("listaSalas", obtenerListaSalas());
});



});

// ================== INICIAR SERVIDOR ==================

server.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});
