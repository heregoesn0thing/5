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
  downwind: 40,
  crosswind: 130,
  base: 310
}
const PUNTO_ORBITA_DOWNWIND = {
  lat: -13.76459547738987,
  lng: -76.19292298449697
}
const TOLERANCIA_PUNTO_ORBITA_M = 120
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
  aeronave.orbitCentro = null
  aeronave.orbitRadio = null
  aeronave.orbitBearing = null
  aeronave.orbitAcumulado = 0
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
  const delta = (ahora - reloj.timestampBase) / 1000 * reloj.velocidad;

  return formatearHora(reloj.tiempoBase + delta);
}
function iniciarMotorSala(nombreSala){

  if (motoresSalas[nombreSala]) return

  motoresSalas[nombreSala] = setInterval(() => {

    const sala = salas[nombreSala]
    if (!sala) return

    const intervaloMS = 50

    sala.aeronaves.forEach(a => {
// 🔥 PRIORIDAD ABSOLUTA LANDING
if (a.estado === "landing") {
  return
}
      // =====================================
      // ✈ MODO MANUAL — PRIORIDAD ABSOLUTA
      // =====================================
      if (a.estado === "manual") {

  const velocidadMPS = a.velocidad || (90 * 0.514444)
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
    estado: a.estado
  })

  return
}

      if (!a.ruta || a.ruta.length < 2) return

      const velocidadMPS = a.velocidad || (90 * 0.514444)
      const distanciaTick = velocidadMPS * (intervaloMS/1000)
// =====================================
// 🌀 FASE ARCO 30° ANTES DE INTERCEPTAR
// =====================================

if (a.estado === "arcoInterceptacion") {

  const destino = a.puntoIntercepto;

  const distancia = distanciaEntre(
    { lat: a.lat, lng: a.lng },
    destino
  );

  const velocidadMPS = a.velocidad || (90 * 0.514444);
  const distanciaTick = velocidadMPS * (intervaloMS / 1000);

  // 🔥 RUMBO HACIA EL PUNTO DE INTERCEPTO
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

  // 🎯 Cuando esté cerca → pasar a interceptación fina
  if (distancia < 120) {
    a.estado = "interceptandoTramo";
    a.interceptTicks = 0;
  }

  io.to(nombreSala).emit("actualizarAeronave", {
    id: a.id,
    lat: a.lat,
    lng: a.lng,
    altitud: a.altitud,
    angulo: a.angulo,
    estado: a.estado
  });

  return;
}
      // =====================================
      // ✈ FASE 1 — INTERCEPTANDO EL CIRCUITO
      // =====================================
if (a.estado === "interceptandoTramo") {

  const A = a.ruta[a.tramoObjetivo];
  const B = a.ruta[(a.tramoObjetivo - 1 + a.ruta.length) % a.ruta.length];

  // 🔥 Proyección dinámica
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

  // 🎯 Rumbo hacia el punto proyectado (NO rumbo del tramo todavía)
  const rumboIntercepto = calcularRumboServidor(
    { lat: a.lat, lng: a.lng },
    puntoProyectado
  );

  const rumboTramo = calcularRumboServidor(A, B);

  // Cuando se acerca al tramo, mezcla progresivamente rumbo de intercepto
  // con rumbo del tramo para producir una captura en curva.
  const distanciaInicioCurva = 320;
  const factorCurva = Math.max(
    0,
    Math.min(1, 1 - (distanciaAlTramo / distanciaInicioCurva))
  );

  const rumboObjetivo = interpolarRumbo(
    rumboIntercepto,
    rumboTramo,
    factorCurva
  );

  const maxGiro = 2.8;

  let diff = diferenciaAngular(a.angulo || rumboObjetivo, rumboObjetivo);

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

  // Captura normal con alineación, y captura de respaldo cuando ya está muy cerca
  // para evitar que orbite indefinidamente alrededor del tramo.
  const capturaPrecisa = distanciaFinalAlTramo < 18 && errorRumbo < 12;
  const capturaCercana = distanciaFinalAlTramo < 48;
  const capturaForzada =
    a.interceptTicks > 220 && distanciaFinalAlTramo < 120;

  if (capturaPrecisa || capturaCercana || capturaForzada) {
    const distanciaSegmento = distanciaEntre(A, B);

    a.lat = proyeccionFinal.punto.lat;
    a.lng = proyeccionFinal.punto.lng;
    a.angulo = rumboTramo;
    a.estado = "circuito";
    a.interceptTicks = 0;
    a.indice = a.tramoObjetivo;
    a.progreso = distanciaSegmento * proyeccionFinal.t;

    console.log("✔ Ingreso curvo capturado");
  }

  io.to(nombreSala).emit("actualizarAeronave", {
    id: a.id,
    lat: a.lat,
    lng: a.lng,
    altitud: a.altitud,
    angulo: a.angulo,
    estado: a.estado
  });

  return;
}
      // =====================================
      // ✈ FASE 2 — MOVIMIENTO NORMAL EN CIRCUITO
      // =====================================
      if (a.estado !== "circuito" && a.estado !== "orbita") return

      if (a.orbitEnCurso) {
        const radioOrbit = Math.max(a.orbitRadio || (0.5 * 1852), 1)
        const circunferencia = 2 * Math.PI * radioOrbit
        const deltaAngular = (distanciaTick / circunferencia) * 360

        // Giro a la derecha (clockwise): el radial desde el centro debe aumentar.
        a.orbitBearing = (a.orbitBearing + deltaAngular) % 360

        const puntoOrbit = puntoPlano(
          a.orbitCentro,
          a.orbitBearing,
          radioOrbit
        )

        a.lat = puntoOrbit.lat
        a.lng = puntoOrbit.lng
        a.angulo = (a.orbitBearing + 90) % 360
        a.orbitAcumulado = (a.orbitAcumulado || 0) + deltaAngular

        if (a.orbitAcumulado >= 360) {
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
              a.lat = proyeccionDownwind.puntoIntercepto.lat
              a.lng = proyeccionDownwind.puntoIntercepto.lng
            }
          }

          a.estado = "circuito"
          a.angulo = RUMBOS_CIRCUITO.downwind
          limpiarOrbitacionAeronave(a)
        }

        io.to(nombreSala).emit("actualizarAeronave", {
          id: a.id,
          lat: a.lat,
          lng: a.lng,
          altitud: a.altitud,
          angulo: a.angulo,
          estado: a.estado
        })

        return
      }

      const siguienteSegmentoActual =
        (a.indice - 1 + a.ruta.length) % a.ruta.length
      const AActual = a.ruta[a.indice]
      const BActual = a.ruta[siguienteSegmentoActual]
      const rumboSegmentoActual = calcularRumboServidor(AActual, BActual)
      const tipoSegmentoActual = clasificarTramoPorRumbo(rumboSegmentoActual)
      const downwindValidoOrbit = esDownwindValidoParaOrbit(
        tipoSegmentoActual,
        rumboSegmentoActual,
        a.angulo
      )

      if (
        a.orbitPendiente &&
        downwindValidoOrbit
      ) {
        const distanciaPuntoOrbit = distanciaEntre(
          { lat: a.lat, lng: a.lng },
          PUNTO_ORBITA_DOWNWIND
        )

        if (distanciaPuntoOrbit <= TOLERANCIA_PUNTO_ORBITA_M) {
          const radioOrbit = 0.5 * 1852
          const rumboBase =
            typeof a.angulo === "number" ? a.angulo : rumboSegmentoActual

          const centroOrbit = puntoPlano(
            { lat: a.lat, lng: a.lng },
            (rumboBase + 90) % 360,
            radioOrbit
          )

          a.orbitEnCurso = true
          a.orbitPendiente = false
          a.estado = "orbita"
          a.orbitCentro = centroOrbit
          a.orbitRadio = radioOrbit
          a.orbitBearing = calcularRumboServidor(
            centroOrbit,
            { lat: a.lat, lng: a.lng }
          )
          a.orbitAcumulado = 0

          io.to(nombreSala).emit("actualizarAeronave", {
            id: a.id,
            lat: a.lat,
            lng: a.lng,
            altitud: a.altitud,
            angulo: a.angulo,
            estado: a.estado
          })

          return
        }
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
  const umbral22 = { lat: -13.734272, lng: -76.211517 }

  const rumboPista = 40
  const rumboInverso = 220
  const rumboIzq = 130   // tráfico izquierdo RWY 22

  const lateralM = 1.0 * 1852

  // 🔥 EXTENSIÓN DINÁMICA
  const extensionBase = 2.5 * 1852
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

  const centroLong = {
    lat: (finalExt.lat + salidaExt.lat)/2,
    lng: (finalExt.lng + salidaExt.lng)/2
  }

  const centro = puntoPlano(centroLong, rumboIzq, lateralM)

  const longitudTotal = distanciaEntre(finalExt, salidaExt)

  const a = longitudTotal / 2
  const b = lateralM
  const n = 4.5
  const pasos = 400

  const puntos = []

  for(let i=0; i<=pasos; i++){

    const t = (i/pasos) * 2*Math.PI

    const cosT = Math.cos(t)
    const sinT = Math.sin(t)

    const x = a * Math.sign(cosT) * Math.pow(Math.abs(cosT), 2/n)
    const y = b * Math.sign(sinT) * Math.pow(Math.abs(sinT), 2/n)

    const headingRad = rumboPista * Math.PI/180

    const xr = x*Math.cos(headingRad) - y*Math.sin(headingRad)
    const yr = x*Math.sin(headingRad) + y*Math.cos(headingRad)

    const distancia = Math.sqrt(xr*xr + yr*yr)
    const rumbo = Math.atan2(yr, xr) * 180/Math.PI

    const punto = puntoPlano(centro, rumbo, distancia)

    puntos.push({
      lat: punto.lat,
      lng: punto.lng
    })
  }

  return puntos
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
  const tipo = clasificarTramoPorRumbo(rumbo)

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

  // Solo consideramos downwind "real" cuando el rumbo está cercano a 040
  return diffDownwind <= 22
}

function buscarInterceptoPorTipo(ruta, tipoObjetivo, posicionActual) {
  if (!ruta || ruta.length < 2) return null

  let mejor = null

  for (let i = 0; i < ruta.length; i++) {
    const A = ruta[i]
    const B = ruta[(i - 1 + ruta.length) % ruta.length]
    const rumbo = calcularRumboServidor(A, B)
    const tipo = clasificarTramoPorRumbo(rumbo)
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
    const tipoSegmento = clasificarTramoPorRumbo(rumboSegmento)

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

    if (a.estado === "circuito") {
      reajustarAeronaveEnRuta(a, rutaAeronave)
      return
    }

    if (
      (a.estado === "arcoInterceptacion" || a.estado === "interceptandoTramo") &&
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

    // 🔥 SINCRONIZAR INMEDIATAMENTE
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
  estado: "idle"
});


  io.to(sala).emit("crearAeronave", {
  id: data.id,
  tipo: data.tipo,
  lat: data.lat,
  lng: data.lng,
  altitud: data.altitud || 0,
  angulo: data.angulo || 0,
  estado: "idle",
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

  // Extensión general heredada + por tramo (compatibilidad)
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

  if (aeronave.estado === "circuito") {
    aeronave.ruta = rutaActualizada

    if (proyeccionTramo) {
      aeronave.indice = proyeccionTramo.indiceA
      aeronave.progreso = proyeccionTramo.progreso
    } else {
      reajustarAeronaveEnRuta(aeronave, rutaActualizada)
    }

    aeronave.angulo = rumboObjetivo
  } else if (
    (aeronave.estado === "arcoInterceptacion" || aeronave.estado === "interceptandoTramo") &&
    aeronave.ruta
  ) {
    aeronave.ruta = rutaActualizada

    if (proyeccionTramo) {
      aeronave.tramoObjetivo = proyeccionTramo.indiceA
      aeronave.puntoIntercepto = proyeccionTramo.puntoIntercepto
      aeronave.estado = "interceptandoTramo"
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
  aeronave.estado = "arcoInterceptacion"
  aeronave.interceptTicks = 0
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
    aeronave.estado !== "circuito" &&
    aeronave.estado !== "arcoInterceptacion" &&
    aeronave.estado !== "interceptandoTramo"
  ) {
    return
  }

  if (aeronave.orbitEnCurso) return
  if (!aeronave.ruta || aeronave.ruta.length < 2) return

  limpiarOrbitacionAeronave(aeronave)
  aeronave.orbitPendiente = true
  iniciarMotorSala(salaNombre)
})


  // ===== ACTUALIZAR AERONAVE =====
socket.on("actualizarAeronave", (data) => {

  const sala = socket.sala;
  if (!sala) return;

  const aeronave = salas[sala].aeronaves.find(a => a.id === data.id);
  if (!aeronave) return;

  // 🔒 Solo el dueño puede actualizar
  if (aeronave.owner !== socket.id) return;

  // 🛡 Validación básica de datos
  if (typeof data.lat !== "number") return;
  if (typeof data.lng !== "number") return;
  if (typeof data.altitud !== "number") return;
  if (typeof data.angulo !== "number") return;
if(typeof data.estado === "string"){
  aeronave.estado = data.estado
}

  aeronave.lat = data.lat;
  aeronave.lng = data.lng;
  aeronave.altitud = data.altitud;
  aeronave.angulo = data.angulo;

  socket.to(sala).emit("actualizarAeronave", {
  id: aeronave.id,
  lat: aeronave.lat,
  lng: aeronave.lng,
  altitud: aeronave.altitud,
  angulo: aeronave.angulo,
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

  if (aeronave.estado === "manual") {

    // DESACTIVAR MANUAL
    aeronave.estado = "idle"

  } else {

    // ACTIVAR MANUAL
    aeronave.estado = "manual"

    aeronave.ruta = null
    aeronave.indice = 0
    aeronave.progreso = 0
    aeronave.indiceObjetivo = null

    if (!aeronave.velocidad) {
      aeronave.velocidad = 90 * 0.514444
    }

    iniciarMotorSala(salaNombre)
  }

  io.to(salaNombre).emit("actualizarAeronave", {
    id: aeronave.id,
    lat: aeronave.lat,
    lng: aeronave.lng,
    altitud: aeronave.altitud,
    angulo: aeronave.angulo,
    velocidad: aeronave.velocidad,
    estado: aeronave.estado
  })
})
// ===== INICIAR CIRCUITO =====
socket.on("iniciarCircuito", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (aeronave.owner !== socket.id) return
  if (
  aeronave.estado === "circuito" ||
  aeronave.estado === "arcoInterceptacion" ||
  aeronave.estado === "interceptandoTramo"
) return

  limpiarOrbitacionAeronave(aeronave)

  // 🔥 GENERAR RUTA
  aeronave.ruta = generarRutaServidorParaAeronave(sala, aeronave)

  // 🔥 ENVIAR RUTA A LOS CLIENTES (AQUÍ VA)
  io.to(salaNombre).emit("rutaCircuito", {
    ruta: aeronave.ruta
  })

 // ===== INTERCEPTAR TRAMO MÁS CERCANO =====

let mejor = {
  distancia: Infinity,
  indiceA: 0,
  puntoIntercepto: null
};

for (let i = 0; i < aeronave.ruta.length; i++) {

  const A = aeronave.ruta[i];
  const B = aeronave.ruta[(i - 1 + aeronave.ruta.length) % aeronave.ruta.length];

  // Proyección sobre segmento
  const punto = proyectarSobreSegmento(
    { lat: aeronave.lat, lng: aeronave.lng },
    A,
    B
  );

  const d = distanciaEntre(
    { lat: aeronave.lat, lng: aeronave.lng },
    punto
  );

  if (d < mejor.distancia) {
    mejor = {
      distancia: d,
      indiceA: i,
      puntoIntercepto: punto
    };
  }
}

aeronave.tramoObjetivo = mejor.indiceA;
aeronave.puntoIntercepto = mejor.puntoIntercepto;
aeronave.estado = "arcoInterceptacion";
aeronave.interceptTicks = 0;
aeronave.velocidad = 90 * 0.514444;

iniciarMotorSala(salaNombre);
})
socket.on("detenerCircuito", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (aeronave.owner !== socket.id) return

  aeronave.estado = "idle"
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

  // 🔥 CANCELAR TODO LO QUE CONTROLE MOVIMIENTO

  limpiarOrbitacionAeronave(aeronave)
  aeronave.ruta = null
  aeronave.indice = 0
  aeronave.progreso = 0
  aeronave.indiceObjetivo = null
  aeronave.puntoIngreso = null

  // 🔥 CANCELAR MANUAL SI ESTABA ACTIVO
  if (aeronave.estado === "manual") {
    aeronave.velocidad = aeronave.velocidad || (90 * 0.514444)
  }

  // 🔥 ESTADO DEFINITIVO DE ATERRIZAJE
  aeronave.estado = "landing"

  io.to(salaNombre).emit("actualizarAeronave", {
    id: aeronave.id,
    lat: aeronave.lat,
    lng: aeronave.lng,
    altitud: aeronave.altitud,
    angulo: aeronave.angulo,
    velocidad: aeronave.velocidad,
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
  if (a.estado !== "manual") return

  if (tipo === "heading") {
    a.angulo = (a.angulo + valor + 360) % 360
  }

  if (tipo === "speed") {

  const nudosEnMPS = valor * 0.514444

  a.velocidad = Math.max(
    0,
    (a.velocidad || 90 * 0.514444) + nudosEnMPS
  )

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
    estado: a.estado
  })

})
  // ===== CONTROL DEL TIEMPO =====
socket.on("controlTiempo", ({ accion, valor }) => {

  const sala = socket.sala;
  if (!sala) return;

  const reloj = relojesSalas[sala];
  if (!reloj) return;

  if (!reloj.pausado) {
    const ahora = Date.now();
    const delta = (ahora - reloj.timestampBase) / 1000 * reloj.velocidad;
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

  if (accion === "velocidad") {
    reloj.velocidad = valor;
    reloj.timestampBase = Date.now();
  }

  // 🔥 NUEVO
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

    // 🟡 Si quedó vacía, iniciar countdown
    if (salas[nombre].jugadores.length === 0) {

      // Evitar múltiples timeouts
      if (timeoutsSalas[nombre]) return;

      console.log(`⏳ Sala ${nombre} vacía. Eliminando en 5 minutos si nadie entra.`);

      timeoutsSalas[nombre] = setTimeout(() => {

        // Verificar nuevamente antes de borrar
        if (salas[nombre] && salas[nombre].jugadores.length === 0) {

          console.log(`🗑 Eliminando sala ${nombre} por inactividad.`);

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

      }, 5 * 60 * 1000); // 5 minutos
    }
  }

  io.emit("listaSalas", obtenerListaSalas());
});



});

// ================== INICIAR SERVIDOR ==================

server.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});
