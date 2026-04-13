const express = require("express");
const http = require("http");
const https = require("https");
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

function descargarTextoHttps(url){
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "simulador-metar-proxy/1.0"
      }
    }, (resp) => {
      const status = Number(resp.statusCode || 0)
      if(status < 200 || status >= 300){
        resp.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }

      let body = ""
      resp.setEncoding("utf8")
      resp.on("data", chunk => {
        body += chunk
      })
      resp.on("end", () => resolve(body))
    })

    req.on("error", reject)
    req.setTimeout(10000, () => {
      req.destroy(new Error("Timeout"))
    })
  })
}

app.get("/api/metar-decoded", async (req, res) => {
  const idsRaw = typeof req.query.ids === "string" ? req.query.ids : "SPSO"
  const hoursRaw = typeof req.query.hours === "string" ? req.query.hours : "0"
  const ids = encodeURIComponent(idsRaw.trim() || "SPSO")
  const hours = encodeURIComponent(hoursRaw.trim() || "0")
  const origen = `https://aviationweather.gov/api/data/metar?ids=${ids}&hours=${hours}&format=decoded`

  try {
    const contenido = await descargarTextoHttps(origen)
    res.setHeader("Cache-Control", "no-store")
    res.type("text/plain").send(contenido)
  } catch (error) {
    res.status(502).type("text/plain").send("METAR upstream unavailable")
  }
})


let salas = {};
let relojesSalas = {};
let intervalosSalas = {};
let peligroSalas = {};
let timeoutsSalas = {};
let motoresSalas = {}
const modosOperacionPorSocket = new Map()
const RUMBOS_CIRCUITO = {
  upwind: 220,
  final: 220,
  downwind: 40,
  crosswind: 130,
  base: 310
}
const RUMBOS_CIRCUITO_DERECHA = {
  upwind: 220,
  final: 220,
  downwind: 40,
  crosswind: 310,
  base: 130
}
const ALTITUD_CIRCUITO_FT = 1500
const ASCENSO_DESCENSO_CIRCUITO_FPM = 1200
const EPSILON_ALTITUD_MANUAL_CIRCUITO_FT = 50
const CLEARED_TO_LAND_BASE_TARGET_FT = 800
const CLEARED_TO_LAND_BASE_DESCENT_FPM = 250
const CLEARED_TO_LAND_BASE_MIN_TOTAL_DIST_M = 50
const TOLERANCIA_REINGRESO_ORBITA_M = 80
const ORBIT_TASA_VIRAJE_GRADOS_SEG = 3
const ORBIT_SENTIDO_DERECHA = 1
const ORBIT_SENTIDO_IZQUIERDA = -1
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
const UMBRAL_04_COORDS = { lat: -13.7553277777778, lng: -76.2293055555556 }
const UMBRAL_22_COORDS = { lat: -13.734536864537288, lng: -76.21175399048074 }
const CIRCUITO_RESET_UMBRAL_22_DIST_M = 45
const SCO_VOR_COORDS = { lat: -13.738611, lng: -76.212778 }
const VARIACION_MAGNETICA_VOR_SCO_OESTE_DEG = 2
const TOUCHDOWN_ZONE_22_COORDS = { ...UMBRAL_22_COORDS }
const GP_DME_ISAN_COORDS = { lat: -13.735730555555556, lng: -76.21406944444445 }
const ASOXI_COORDS_SERVIDOR = { lat: -12.760556, lng: -76.606389 }

function convertirRadialScoMagneticoAVerdadero(radialMagnetico) {
  return normalizarAngulo360(
    Number(radialMagnetico) - VARIACION_MAGNETICA_VOR_SCO_OESTE_DEG
  )
}

function puntoPlanoEnRadialSco(radialMagnetico, distancia) {
  return puntoPlano(
    SCO_VOR_COORDS,
    convertirRadialScoMagneticoAVerdadero(radialMagnetico),
    distancia
  )
}

const PUNTO_REFERENCIA_EJE_041_UMBRAL_22_COORDS = puntoPlano(
  UMBRAL_22_COORDS,
  41,
  1000
)
const PUNTO_REFERENCIA_EJE_FINAL_RWY22_COORDS = puntoPlano(
  UMBRAL_22_COORDS,
  calcularRumboServidor(UMBRAL_04_COORDS, UMBRAL_22_COORDS),
  1000
)
const SCO_RADIAL_022_5NM_COORDS = puntoPlanoEnRadialSco(22, 5 * 1852)
const SCO_RADIAL_017_8NM_COORDS = puntoPlanoEnRadialSco(17, 8 * 1852)
const SCO_RADIAL_040_9NM_COORDS = puntoPlanoEnRadialSco(40, 9 * 1852)
const SCO_RADIAL_041_4NM_COORDS = puntoPlanoEnRadialSco(41, 4 * 1852)
const SCO_RADIAL_041_3NM_COORDS = puntoPlanoEnRadialSco(41, 3 * 1852)
const SCO_RADIAL_041_2NM_COORDS = puntoPlanoEnRadialSco(41, 2 * 1852)
const GEBED_COORDS_SERVIDOR = puntoPlanoEnRadialSco(341, 35 * 1852)
const MUMOP_COORDS_SERVIDOR = puntoPlanoEnRadialSco(341, 11 * 1852)
const KOLMI_COORDS_SERVIDOR = { lat: -13.67305556, lng: -76.16000000 }
const SILAM_COORDS_SERVIDOR = { lat: -13.69500000, lng: -76.17833333 }
const GO_AROUND_TRIGGER_POINT = {
  lat: -13.737274259116425,
  lng: -76.21411085128786
}
const GO_AROUND_TRIGGER_HEADING = 222
const GO_AROUND_TRIGGER_HEADING_TOL = 8
const GO_AROUND_TRIGGER_DISTANCE_M = 140
const PYROTECHNIC_LIGHT_DURATION_MS = 30000
const GO_AROUND_RADIAL_OBJETIVO = 250
const GO_AROUND_INTERCEPT_TOL = 3
const GO_AROUND_CLIMB_TARGET_FT = 2000
const GO_AROUND_CLIMB_RATE_FPM = 1200
const GO_AROUND_SPEED_DEFAULT_KT = 90
const GO_AROUND_SPEED_TARGET_KT = 250
const GO_AROUND_ACCEL_KT_POR_SEG = 8
const GO_AROUND_MANUAL_SWITCH_DISTANCE_M = 5 * 1852
const GO_AROUND_FINAL_HEADING_ACTIVACION_TOL = 35
const GO_AROUND_FINAL_MAX_DIST_M = 1800
const INTERCEPT_LEG_LOOKAHEAD_MIN_M = 90
const SHORT_CIRCUITO_FACTOR = 0.5
const SHORT_CIRCUITO_PASO_M = 0.5 * 1852
const CIRCUITO_LONGITUD_FINAL_BASE_M = 1.5 * 1852
const CIRCUITO_LONGITUD_FINAL_SHORT_M = 1.0 * 1852
const CIRCUITO_LONGITUD_UPWIND_BASE_M = 2.2 * 1852
const PILOTAGE_DEFAULT_SPEED_INITIAL_KT = 90
const PILOTAGE_REALISTIC_BANK_DEG = 22
const PILOTAGE_REALISTIC_TURN_RATE_MIN_DEG_PER_SEC = 2
const PILOTAGE_REALISTIC_TURN_RATE_MAX_DEG_PER_SEC = 5.8

function calcularInterseccionSemiejeConCirculoServidor(
  origenSemieje,
  puntoDireccionSemieje,
  centroCirculo,
  radioMetros
){
  if(
    !origenSemieje ||
    !puntoDireccionSemieje ||
    !centroCirculo
  ){
    return null
  }

  const origenLat = Number(origenSemieje.lat)
  const origenLng = Number(origenSemieje.lng)
  const direccionLat = Number(puntoDireccionSemieje.lat)
  const direccionLng = Number(puntoDireccionSemieje.lng)
  const centroLat = Number(centroCirculo.lat)
  const centroLng = Number(centroCirculo.lng)
  const radio = Math.max(0, Number(radioMetros) || 0)
  const latFactor = 111320
  const lngFactor = 111320 * Math.cos(origenLat * Math.PI / 180)
  if(
    !Number.isFinite(origenLat) ||
    !Number.isFinite(origenLng) ||
    !Number.isFinite(direccionLat) ||
    !Number.isFinite(direccionLng) ||
    !Number.isFinite(centroLat) ||
    !Number.isFinite(centroLng) ||
    !Number.isFinite(radio) ||
    radio <= 0 ||
    !Number.isFinite(lngFactor) ||
    Math.abs(lngFactor) < 1e-6
  ){
    return null
  }

  const dx = (direccionLng - origenLng) * lngFactor
  const dy = (direccionLat - origenLat) * latFactor
  const fx = (origenLng - centroLng) * lngFactor
  const fy = (origenLat - centroLat) * latFactor
  const a = (dx * dx) + (dy * dy)
  const b = 2 * ((fx * dx) + (fy * dy))
  const c = (fx * fx) + (fy * fy) - (radio * radio)
  const discriminante = (b * b) - (4 * a * c)
  if(a <= 1e-6 || discriminante < 0){
    return null
  }

  const raiz = Math.sqrt(discriminante)
  const candidatos = [
    (-b + raiz) / (2 * a),
    (-b - raiz) / (2 * a)
  ]
    .filter(valor => Number.isFinite(valor))
    .sort((aValor, bValor) => bValor - aValor)
  const tSeleccionado =
    candidatos.find(valor => valor >= 0) ?? candidatos[0]
  if(!Number.isFinite(tSeleccionado)){
    return null
  }

  return {
    lat: origenLat + ((dy * tSeleccionado) / latFactor),
    lng: origenLng + ((dx * tSeleccionado) / lngFactor)
  }
}

const CLIMB_RATE = {
  A320: 2500,
  A319: 2500,
  A19: 2500,
  AN32: 1500,
  C172: 400,
  PA23: 1400,
  PA28: 700,
  PA31: 1450,
  PA34: 1550,
  PA44: 1340
}
const DESCENT_RATE = {
  A320: 1500,
  A319: 1500,
  A19: 1500,
  AN32: 1000,
  C172: 500,
  PA23: 1000,
  PA28: 600,
  PA31: 1100,
  PA34: 1100,
  PA44: 900
}
const TAKEOFF_PROFILE_A32X = {
  RUNWAY_DISTANCE_M: 1750,
  ROTATION_KT: 145,
  RUNWAY_TARGET_KT: 135,
  SPEED_TO_FL050_KT: 165,
  SPEED_TO_FL150_KT: 290,
  SPEED_TO_FL240_KT: 290,
  CRUISE_MAX_KT: 450,
  DEFAULT_TARGET_ALT_FT: 24000,
  ROC_TO_FL050_FPM: 2500,
  ROC_TO_FL150_FPM: 2500,
  ROC_TO_FL240_FPM: 2500,
  FL050_FT: 5000,
  FL150_FT: 15000,
  FL240_FT: 24000,
  RUNWAY_ACCEL_MAX_MPS2: 1.8,
  RUNWAY_ACCEL_MIN_MPS2: 0.9,
  CLIMB_ACCEL_KT_PER_SEC: 2.3
}

function crearPerfilDespegue(base, overrides = {}){
  return Object.freeze({
    ...base,
    ...overrides
  })
}

const TAKEOFF_PROFILE_BASE = Object.freeze({
  RUNWAY_DISTANCE_M: 450,
  ROTATION_KT: 60,
  RUNWAY_TARGET_KT: 72,
  SPEED_TO_FL050_KT: 100,
  SPEED_TO_FL150_KT: 140,
  SPEED_TO_FL240_KT: 170,
  CRUISE_MAX_KT: 190,
  DEFAULT_TARGET_ALT_FT: 6000,
  ROC_TO_FL050_FPM: 900,
  ROC_TO_FL150_FPM: 650,
  ROC_TO_FL240_FPM: 400,
  FL050_FT: 5000,
  FL150_FT: 15000,
  FL240_FT: 24000,
  RUNWAY_ACCEL_MAX_MPS2: 1.4,
  RUNWAY_ACCEL_MIN_MPS2: 0.75,
  CLIMB_ACCEL_KT_PER_SEC: 1.2
})

const TAKEOFF_PROFILE_LIGHT_SINGLE = crearPerfilDespegue(TAKEOFF_PROFILE_BASE)
const TAKEOFF_PROFILE_LIGHT_TWIN = crearPerfilDespegue(TAKEOFF_PROFILE_BASE, {
  RUNWAY_DISTANCE_M: 620,
  ROTATION_KT: 72,
  RUNWAY_TARGET_KT: 84,
  SPEED_TO_FL050_KT: 110,
  SPEED_TO_FL150_KT: 150,
  SPEED_TO_FL240_KT: 175,
  CRUISE_MAX_KT: 195,
  DEFAULT_TARGET_ALT_FT: 9000,
  ROC_TO_FL050_FPM: 1100,
  ROC_TO_FL150_FPM: 800,
  ROC_TO_FL240_FPM: 500,
  RUNWAY_ACCEL_MAX_MPS2: 1.45,
  RUNWAY_ACCEL_MIN_MPS2: 0.8,
  CLIMB_ACCEL_KT_PER_SEC: 1.1
})
const TAKEOFF_PROFILE_TURBOPROP = crearPerfilDespegue(TAKEOFF_PROFILE_BASE, {
  RUNWAY_DISTANCE_M: 900,
  ROTATION_KT: 90,
  RUNWAY_TARGET_KT: 105,
  SPEED_TO_FL050_KT: 140,
  SPEED_TO_FL150_KT: 210,
  SPEED_TO_FL240_KT: 255,
  CRUISE_MAX_KT: 290,
  DEFAULT_TARGET_ALT_FT: 18000,
  ROC_TO_FL050_FPM: 1900,
  ROC_TO_FL150_FPM: 1400,
  ROC_TO_FL240_FPM: 900,
  RUNWAY_ACCEL_MAX_MPS2: 1.8,
  RUNWAY_ACCEL_MIN_MPS2: 0.95,
  CLIMB_ACCEL_KT_PER_SEC: 1.8
})
const TAKEOFF_PROFILE_JET = crearPerfilDespegue(TAKEOFF_PROFILE_A32X)
const TAKEOFF_PROFILE_HELICOPTER = crearPerfilDespegue(TAKEOFF_PROFILE_BASE, {
  RUNWAY_DISTANCE_M: 60,
  ROTATION_KT: 35,
  RUNWAY_TARGET_KT: 50,
  SPEED_TO_FL050_KT: 80,
  SPEED_TO_FL150_KT: 110,
  SPEED_TO_FL240_KT: 130,
  CRUISE_MAX_KT: 150,
  DEFAULT_TARGET_ALT_FT: 4000,
  ROC_TO_FL050_FPM: 1200,
  ROC_TO_FL150_FPM: 900,
  ROC_TO_FL240_FPM: 600,
  RUNWAY_ACCEL_MAX_MPS2: 1.0,
  RUNWAY_ACCEL_MIN_MPS2: 0.5,
  CLIMB_ACCEL_KT_PER_SEC: 1.0
})
const TAKEOFF_PROFILE_FIGHTER = crearPerfilDespegue(TAKEOFF_PROFILE_BASE, {
  RUNWAY_DISTANCE_M: 500,
  ROTATION_KT: 130,
  RUNWAY_TARGET_KT: 155,
  SPEED_TO_FL050_KT: 240,
  SPEED_TO_FL150_KT: 360,
  SPEED_TO_FL240_KT: 430,
  CRUISE_MAX_KT: 450,
  DEFAULT_TARGET_ALT_FT: 28000,
  ROC_TO_FL050_FPM: 17000,
  ROC_TO_FL150_FPM: 11000,
  ROC_TO_FL240_FPM: 6500,
  RUNWAY_ACCEL_MAX_MPS2: 4.0,
  RUNWAY_ACCEL_MIN_MPS2: 2.0,
  CLIMB_ACCEL_KT_PER_SEC: 5.6
})

const TAKEOFF_PROFILES = Object.freeze({
  C152: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_SINGLE, {
    RUNWAY_DISTANCE_M: 260,
    ROTATION_KT: 52,
    RUNWAY_TARGET_KT: 60,
    SPEED_TO_FL050_KT: 80,
    SPEED_TO_FL150_KT: 95,
    SPEED_TO_FL240_KT: 105,
    CRUISE_MAX_KT: 110,
    DEFAULT_TARGET_ALT_FT: 4000,
    ROC_TO_FL050_FPM: 700,
    ROC_TO_FL150_FPM: 450,
    ROC_TO_FL240_FPM: 250,
    RUNWAY_ACCEL_MAX_MPS2: 1.25,
    RUNWAY_ACCEL_MIN_MPS2: 0.7,
    CLIMB_ACCEL_KT_PER_SEC: 0.8
  }),
  C172: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_SINGLE, {
    RUNWAY_DISTANCE_M: 380,
    ROTATION_KT: 55,
    RUNWAY_TARGET_KT: 65,
    SPEED_TO_FL050_KT: 85,
    SPEED_TO_FL150_KT: 100,
    SPEED_TO_FL240_KT: 110,
    CRUISE_MAX_KT: 120,
    DEFAULT_TARGET_ALT_FT: 5000,
    ROC_TO_FL050_FPM: 500,
    ROC_TO_FL150_FPM: 350,
    ROC_TO_FL240_FPM: 200,
    RUNWAY_ACCEL_MAX_MPS2: 1.3,
    RUNWAY_ACCEL_MIN_MPS2: 0.75,
    CLIMB_ACCEL_KT_PER_SEC: 0.9
  }),
  C180: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_SINGLE, {
    RUNWAY_DISTANCE_M: 470,
    ROTATION_KT: 58,
    RUNWAY_TARGET_KT: 72,
    SPEED_TO_FL050_KT: 95,
    SPEED_TO_FL150_KT: 120,
    SPEED_TO_FL240_KT: 140,
    CRUISE_MAX_KT: 160,
    DEFAULT_TARGET_ALT_FT: 7000,
    ROC_TO_FL050_FPM: 1000,
    ROC_TO_FL150_FPM: 700,
    ROC_TO_FL240_FPM: 450,
    RUNWAY_ACCEL_MAX_MPS2: 1.5,
    RUNWAY_ACCEL_MIN_MPS2: 0.85,
    CLIMB_ACCEL_KT_PER_SEC: 1.1
  }),
  C206: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_SINGLE, {
    RUNWAY_DISTANCE_M: 620,
    ROTATION_KT: 63,
    RUNWAY_TARGET_KT: 78,
    SPEED_TO_FL050_KT: 100,
    SPEED_TO_FL150_KT: 125,
    SPEED_TO_FL240_KT: 145,
    CRUISE_MAX_KT: 165,
    DEFAULT_TARGET_ALT_FT: 8000,
    ROC_TO_FL050_FPM: 950,
    ROC_TO_FL150_FPM: 700,
    ROC_TO_FL240_FPM: 450,
    RUNWAY_ACCEL_MAX_MPS2: 1.55,
    RUNWAY_ACCEL_MIN_MPS2: 0.9,
    CLIMB_ACCEL_KT_PER_SEC: 1.15
  }),
  PA28: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_SINGLE, {
    RUNWAY_DISTANCE_M: 450,
    ROTATION_KT: 60,
    RUNWAY_TARGET_KT: 70,
    SPEED_TO_FL050_KT: 90,
    SPEED_TO_FL150_KT: 115,
    SPEED_TO_FL240_KT: 125,
    CRUISE_MAX_KT: 140,
    DEFAULT_TARGET_ALT_FT: 6000,
    ROC_TO_FL050_FPM: 700,
    ROC_TO_FL150_FPM: 500,
    ROC_TO_FL240_FPM: 300,
    RUNWAY_ACCEL_MAX_MPS2: 1.35,
    RUNWAY_ACCEL_MIN_MPS2: 0.78,
    CLIMB_ACCEL_KT_PER_SEC: 0.95
  }),
  Z42: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_SINGLE, {
    RUNWAY_DISTANCE_M: 250,
    ROTATION_KT: 45,
    RUNWAY_TARGET_KT: 55,
    SPEED_TO_FL050_KT: 80,
    SPEED_TO_FL150_KT: 95,
    SPEED_TO_FL240_KT: 105,
    CRUISE_MAX_KT: 125,
    DEFAULT_TARGET_ALT_FT: 4500,
    ROC_TO_FL050_FPM: 800,
    ROC_TO_FL150_FPM: 550,
    ROC_TO_FL240_FPM: 300,
    RUNWAY_ACCEL_MAX_MPS2: 1.2,
    RUNWAY_ACCEL_MIN_MPS2: 0.7,
    CLIMB_ACCEL_KT_PER_SEC: 0.85
  }),
  C208: crearPerfilDespegue(TAKEOFF_PROFILE_TURBOPROP, {
    RUNWAY_DISTANCE_M: 800,
    ROTATION_KT: 78,
    RUNWAY_TARGET_KT: 92,
    SPEED_TO_FL050_KT: 120,
    SPEED_TO_FL150_KT: 160,
    SPEED_TO_FL240_KT: 185,
    CRUISE_MAX_KT: 200,
    DEFAULT_TARGET_ALT_FT: 12000,
    ROC_TO_FL050_FPM: 950,
    ROC_TO_FL150_FPM: 700,
    ROC_TO_FL240_FPM: 450,
    RUNWAY_ACCEL_MAX_MPS2: 1.5,
    RUNWAY_ACCEL_MIN_MPS2: 0.85,
    CLIMB_ACCEL_KT_PER_SEC: 1.2
  }),
  PC12: crearPerfilDespegue(TAKEOFF_PROFILE_TURBOPROP, {
    RUNWAY_DISTANCE_M: 790,
    ROTATION_KT: 85,
    RUNWAY_TARGET_KT: 100,
    SPEED_TO_FL050_KT: 140,
    SPEED_TO_FL150_KT: 190,
    SPEED_TO_FL240_KT: 240,
    CRUISE_MAX_KT: 280,
    DEFAULT_TARGET_ALT_FT: 18000,
    ROC_TO_FL050_FPM: 1800,
    ROC_TO_FL150_FPM: 1200,
    ROC_TO_FL240_FPM: 800,
    RUNWAY_ACCEL_MAX_MPS2: 1.8,
    RUNWAY_ACCEL_MIN_MPS2: 0.95,
    CLIMB_ACCEL_KT_PER_SEC: 1.8
  }),
  PA23: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_TWIN, {
    RUNWAY_DISTANCE_M: 650,
    ROTATION_KT: 70,
    RUNWAY_TARGET_KT: 82,
    SPEED_TO_FL050_KT: 110,
    SPEED_TO_FL150_KT: 145,
    SPEED_TO_FL240_KT: 165,
    CRUISE_MAX_KT: 190,
    DEFAULT_TARGET_ALT_FT: 9000
  }),
  PA31: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_TWIN, {
    RUNWAY_DISTANCE_M: 760,
    ROTATION_KT: 78,
    RUNWAY_TARGET_KT: 90,
    SPEED_TO_FL050_KT: 120,
    SPEED_TO_FL150_KT: 170,
    SPEED_TO_FL240_KT: 195,
    CRUISE_MAX_KT: 220,
    DEFAULT_TARGET_ALT_FT: 12000,
    ROC_TO_FL050_FPM: 1600,
    ROC_TO_FL150_FPM: 1150,
    ROC_TO_FL240_FPM: 750,
    RUNWAY_ACCEL_MAX_MPS2: 1.65,
    RUNWAY_ACCEL_MIN_MPS2: 0.9,
    CLIMB_ACCEL_KT_PER_SEC: 1.35
  }),
  PA34: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_TWIN, {
    RUNWAY_DISTANCE_M: 600,
    ROTATION_KT: 75,
    RUNWAY_TARGET_KT: 86,
    SPEED_TO_FL050_KT: 110,
    SPEED_TO_FL150_KT: 155,
    SPEED_TO_FL240_KT: 175,
    CRUISE_MAX_KT: 200,
    DEFAULT_TARGET_ALT_FT: 10000,
    ROC_TO_FL050_FPM: 1100,
    ROC_TO_FL150_FPM: 850,
    ROC_TO_FL240_FPM: 550,
    RUNWAY_ACCEL_MAX_MPS2: 1.5,
    RUNWAY_ACCEL_MIN_MPS2: 0.82,
    CLIMB_ACCEL_KT_PER_SEC: 1.15
  }),
  PA44: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_TWIN, {
    RUNWAY_DISTANCE_M: 470,
    ROTATION_KT: 68,
    RUNWAY_TARGET_KT: 80,
    SPEED_TO_FL050_KT: 100,
    SPEED_TO_FL150_KT: 140,
    SPEED_TO_FL240_KT: 160,
    CRUISE_MAX_KT: 185,
    ROC_TO_FL050_FPM: 1000,
    ROC_TO_FL150_FPM: 750,
    ROC_TO_FL240_FPM: 500,
    RUNWAY_ACCEL_MAX_MPS2: 1.4,
    RUNWAY_ACCEL_MIN_MPS2: 0.78,
    CLIMB_ACCEL_KT_PER_SEC: 1.0
  }),
  C303: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_TWIN, {
    RUNWAY_DISTANCE_M: 650,
    ROTATION_KT: 72,
    RUNWAY_TARGET_KT: 84,
    SPEED_TO_FL050_KT: 110,
    SPEED_TO_FL150_KT: 150,
    SPEED_TO_FL240_KT: 170,
    CRUISE_MAX_KT: 190,
    DEFAULT_TARGET_ALT_FT: 10000,
    ROC_TO_FL050_FPM: 1200,
    ROC_TO_FL150_FPM: 900,
    ROC_TO_FL240_FPM: 600
  }),
  C402: crearPerfilDespegue(TAKEOFF_PROFILE_LIGHT_TWIN, {
    RUNWAY_DISTANCE_M: 780,
    ROTATION_KT: 82,
    RUNWAY_TARGET_KT: 96,
    SPEED_TO_FL050_KT: 125,
    SPEED_TO_FL150_KT: 170,
    SPEED_TO_FL240_KT: 190,
    CRUISE_MAX_KT: 230,
    DEFAULT_TARGET_ALT_FT: 12000,
    ROC_TO_FL050_FPM: 1400,
    ROC_TO_FL150_FPM: 1000,
    ROC_TO_FL240_FPM: 650,
    RUNWAY_ACCEL_MAX_MPS2: 1.55,
    RUNWAY_ACCEL_MIN_MPS2: 0.85,
    CLIMB_ACCEL_KT_PER_SEC: 1.25
  }),
  BE20: crearPerfilDespegue(TAKEOFF_PROFILE_TURBOPROP, {
    RUNWAY_DISTANCE_M: 930,
    ROTATION_KT: 94,
    RUNWAY_TARGET_KT: 110,
    SPEED_TO_FL050_KT: 140,
    SPEED_TO_FL150_KT: 220,
    SPEED_TO_FL240_KT: 255,
    CRUISE_MAX_KT: 290,
    DEFAULT_TARGET_ALT_FT: 22000,
    ROC_TO_FL050_FPM: 2500,
    ROC_TO_FL150_FPM: 1800,
    ROC_TO_FL240_FPM: 1200,
    RUNWAY_ACCEL_MAX_MPS2: 1.85,
    RUNWAY_ACCEL_MIN_MPS2: 0.95,
    CLIMB_ACCEL_KT_PER_SEC: 1.9
  }),
  B190: crearPerfilDespegue(TAKEOFF_PROFILE_TURBOPROP, {
    RUNWAY_DISTANCE_M: 1100,
    ROTATION_KT: 104,
    RUNWAY_TARGET_KT: 120,
    SPEED_TO_FL050_KT: 150,
    SPEED_TO_FL150_KT: 230,
    SPEED_TO_FL240_KT: 270,
    CRUISE_MAX_KT: 300,
    DEFAULT_TARGET_ALT_FT: 24000,
    ROC_TO_FL050_FPM: 2500,
    ROC_TO_FL150_FPM: 1800,
    ROC_TO_FL240_FPM: 1200,
    RUNWAY_ACCEL_MAX_MPS2: 1.9,
    RUNWAY_ACCEL_MIN_MPS2: 1.0,
    CLIMB_ACCEL_KT_PER_SEC: 2.0
  }),
  DHC6: crearPerfilDespegue(TAKEOFF_PROFILE_TURBOPROP, {
    RUNWAY_DISTANCE_M: 480,
    ROTATION_KT: 70,
    RUNWAY_TARGET_KT: 85,
    SPEED_TO_FL050_KT: 110,
    SPEED_TO_FL150_KT: 150,
    SPEED_TO_FL240_KT: 175,
    CRUISE_MAX_KT: 190,
    DEFAULT_TARGET_ALT_FT: 10000,
    ROC_TO_FL050_FPM: 1600,
    ROC_TO_FL150_FPM: 1100,
    ROC_TO_FL240_FPM: 700,
    RUNWAY_ACCEL_MAX_MPS2: 1.6,
    RUNWAY_ACCEL_MIN_MPS2: 0.85,
    CLIMB_ACCEL_KT_PER_SEC: 1.3
  }),
  AN32: crearPerfilDespegue(TAKEOFF_PROFILE_TURBOPROP, {
    RUNWAY_DISTANCE_M: 1050,
    ROTATION_KT: 102,
    RUNWAY_TARGET_KT: 118,
    SPEED_TO_FL050_KT: 145,
    SPEED_TO_FL150_KT: 205,
    SPEED_TO_FL240_KT: 255,
    CRUISE_MAX_KT: 290,
    DEFAULT_TARGET_ALT_FT: 20000,
    ROC_TO_FL050_FPM: 1900,
    ROC_TO_FL150_FPM: 1400,
    ROC_TO_FL240_FPM: 900,
    CLIMB_ACCEL_KT_PER_SEC: 1.6
  }),
  KT1: crearPerfilDespegue(TAKEOFF_PROFILE_TURBOPROP, {
    RUNWAY_DISTANCE_M: 560,
    ROTATION_KT: 82,
    RUNWAY_TARGET_KT: 96,
    SPEED_TO_FL050_KT: 130,
    SPEED_TO_FL150_KT: 210,
    SPEED_TO_FL240_KT: 270,
    CRUISE_MAX_KT: 320,
    DEFAULT_TARGET_ALT_FT: 18000,
    ROC_TO_FL050_FPM: 2600,
    ROC_TO_FL150_FPM: 1800,
    ROC_TO_FL240_FPM: 1100,
    RUNWAY_ACCEL_MAX_MPS2: 1.95,
    RUNWAY_ACCEL_MIN_MPS2: 1.0,
    CLIMB_ACCEL_KT_PER_SEC: 2.4
  }),
  A319: crearPerfilDespegue(TAKEOFF_PROFILE_JET, {
    RUNWAY_DISTANCE_M: 1550,
    ROTATION_KT: 138,
    RUNWAY_TARGET_KT: 148,
    SPEED_TO_FL050_KT: 170,
    SPEED_TO_FL150_KT: 290,
    SPEED_TO_FL240_KT: 300,
    CRUISE_MAX_KT: 450,
    DEFAULT_TARGET_ALT_FT: 24000,
    ROC_TO_FL050_FPM: 2500,
    ROC_TO_FL150_FPM: 2500,
    ROC_TO_FL240_FPM: 2000,
    RUNWAY_ACCEL_MAX_MPS2: 1.95,
    RUNWAY_ACCEL_MIN_MPS2: 1.0,
    CLIMB_ACCEL_KT_PER_SEC: 2.2
  }),
  A320: crearPerfilDespegue(TAKEOFF_PROFILE_JET, {
    RUNWAY_DISTANCE_M: 1700,
    ROTATION_KT: 145,
    RUNWAY_TARGET_KT: 155,
    SPEED_TO_FL050_KT: 175,
    SPEED_TO_FL150_KT: 295,
    SPEED_TO_FL240_KT: 305,
    CRUISE_MAX_KT: 450,
    DEFAULT_TARGET_ALT_FT: 24000,
    ROC_TO_FL050_FPM: 2500,
    ROC_TO_FL150_FPM: 2500,
    ROC_TO_FL240_FPM: 2000,
    RUNWAY_ACCEL_MAX_MPS2: 2.0,
    RUNWAY_ACCEL_MIN_MPS2: 1.0,
    CLIMB_ACCEL_KT_PER_SEC: 2.3
  }),
  B737: crearPerfilDespegue(TAKEOFF_PROFILE_JET, {
    RUNWAY_DISTANCE_M: 1650,
    ROTATION_KT: 143,
    RUNWAY_TARGET_KT: 153,
    SPEED_TO_FL050_KT: 175,
    SPEED_TO_FL150_KT: 295,
    SPEED_TO_FL240_KT: 305,
    CRUISE_MAX_KT: 450,
    DEFAULT_TARGET_ALT_FT: 24000,
    ROC_TO_FL050_FPM: 2600,
    ROC_TO_FL150_FPM: 2400,
    ROC_TO_FL240_FPM: 1900,
    RUNWAY_ACCEL_MAX_MPS2: 2.0,
    RUNWAY_ACCEL_MIN_MPS2: 1.0,
    CLIMB_ACCEL_KT_PER_SEC: 2.3
  }),
  B738WX: crearPerfilDespegue(TAKEOFF_PROFILE_JET, {
    RUNWAY_DISTANCE_M: 1650,
    ROTATION_KT: 143,
    RUNWAY_TARGET_KT: 153,
    SPEED_TO_FL050_KT: 175,
    SPEED_TO_FL150_KT: 295,
    SPEED_TO_FL240_KT: 305,
    CRUISE_MAX_KT: 450,
    DEFAULT_TARGET_ALT_FT: 24000,
    ROC_TO_FL050_FPM: 2600,
    ROC_TO_FL150_FPM: 2400,
    ROC_TO_FL240_FPM: 1900,
    RUNWAY_ACCEL_MAX_MPS2: 2.0,
    RUNWAY_ACCEL_MIN_MPS2: 1.0,
    CLIMB_ACCEL_KT_PER_SEC: 2.3
  }),
  EC45: crearPerfilDespegue(TAKEOFF_PROFILE_HELICOPTER, {
    RUNWAY_DISTANCE_M: 40
  }),
  MI17: crearPerfilDespegue(TAKEOFF_PROFILE_HELICOPTER, {
    RUNWAY_DISTANCE_M: 70,
    ROTATION_KT: 40,
    RUNWAY_TARGET_KT: 60,
    SPEED_TO_FL050_KT: 90,
    SPEED_TO_FL150_KT: 120,
    SPEED_TO_FL240_KT: 145,
    CRUISE_MAX_KT: 160,
    DEFAULT_TARGET_ALT_FT: 5000,
    ROC_TO_FL050_FPM: 1400,
    ROC_TO_FL150_FPM: 1100,
    ROC_TO_FL240_FPM: 700,
    RUNWAY_ACCEL_MAX_MPS2: 1.1,
    RUNWAY_ACCEL_MIN_MPS2: 0.55,
    CLIMB_ACCEL_KT_PER_SEC: 1.1
  }),
  F22: crearPerfilDespegue(TAKEOFF_PROFILE_FIGHTER, {
    RUNWAY_DISTANCE_M: 420,
    ROTATION_KT: 135,
    RUNWAY_TARGET_KT: 160,
    SPEED_TO_FL050_KT: 250,
    SPEED_TO_FL150_KT: 380,
    SPEED_TO_FL240_KT: 450,
    CRUISE_MAX_KT: 450,
    DEFAULT_TARGET_ALT_FT: 30000,
    ROC_TO_FL050_FPM: 18000,
    ROC_TO_FL150_FPM: 12000,
    ROC_TO_FL240_FPM: 7000,
    RUNWAY_ACCEL_MAX_MPS2: 4.2,
    RUNWAY_ACCEL_MIN_MPS2: 2.2,
    CLIMB_ACCEL_KT_PER_SEC: 6.0
  }),
  RFAL: crearPerfilDespegue(TAKEOFF_PROFILE_FIGHTER, {
    RUNWAY_DISTANCE_M: 480,
    ROTATION_KT: 132,
    RUNWAY_TARGET_KT: 158
  }),
  B2: crearPerfilDespegue(TAKEOFF_PROFILE_FIGHTER, {
    RUNWAY_DISTANCE_M: 1500,
    ROTATION_KT: 150,
    RUNWAY_TARGET_KT: 170,
    SPEED_TO_FL050_KT: 220,
    SPEED_TO_FL150_KT: 300,
    SPEED_TO_FL240_KT: 380,
    CRUISE_MAX_KT: 420,
    DEFAULT_TARGET_ALT_FT: 28000,
    ROC_TO_FL050_FPM: 4500,
    ROC_TO_FL150_FPM: 3200,
    ROC_TO_FL240_FPM: 2200,
    RUNWAY_ACCEL_MAX_MPS2: 2.3,
    RUNWAY_ACCEL_MIN_MPS2: 1.1,
    CLIMB_ACCEL_KT_PER_SEC: 2.8
  })
})
const PROCEDIMIENTO_LLEGADA_HOLDING_SCO_CLAVE = "HOLDING SCO ANTIHORARIO"
const PROCEDIMIENTO_LLEGADA_GEBED3_HOLDING_MUMOP_CLAVE = "GEBED3 / HOLDING MUMOP"
const ALTITUD_MINIMA_HOLDING_MUMOP_FT = 4000
const PROCEDIMIENTO_LLEGADA_ILS_U_CLAVE = "APROXIMACION ILS U"
const PROCEDIMIENTO_LLEGADA_ILS_T_CLAVE = "APROXIMACION ILS T"
const PROCEDIMIENTO_LLEGADA_ILS_V_CLAVE = "APROXIMACION ILS V"
const PROCEDIMIENTO_LLEGADA_VOR_V_CLAVE = "APROXIMACION VOR V"
const PROCEDIMIENTO_LLEGADA_VOR_U_CLAVE = "APROXIMACION VOR U"
const PROCEDIMIENTO_LLEGADA_VOR_T_CLAVE = "APROXIMACION VOR T"
const ESTADOS_VELOCIDAD_MPS = new Set([
  "MANUAL",
  "AUTO",
  "PILOTAGE",
  "CIRCUIT",
  "ORBT",
  "INTERCEPTING ARC",
  "INTERCEPTING LEG",
  "INTERCEPTING",
  "TNG_FINAL",
  "TNG_ROLL",
  "TNG_CLIMB",
  "TNG_INTERCEPT",
  "LANDING",
  "ROLLOUT",
  "GO AROUND",
  "TAXI"
])
const ESTADOS_RUTA_SERVIDOR = new Set([
  "INTERCEPTING ARC",
  "INTERCEPTING LEG",
  "CIRCUIT",
  "ORBT",
  "CLEARED TO LAND"
])
const MOVIMIENTO_AUTORITATIVO_SERVIDOR = true
const ESTADOS_MOVIMIENTO_SERVIDOR = new Set([
  "AIRBORNE",
  "MANUAL",
  "AUTO",
  "PILOTAGE",
  "CIRCUIT",
  "ORBT",
  "INTERCEPTING ARC",
  "INTERCEPTING LEG",
  "INTERCEPTING",
  "CLEARED TO LAND",
  "GO AROUND",
  "LANDING",
  "ROLLOUT",
  "TAXI",
  "TNG_FINAL",
  "TNG_ROLL",
  "TNG_CLIMB",
  "TNG_INTERCEPT",
  "REJOINING"
])

function estadoVelocidadEnMps(estado){
  return ESTADOS_VELOCIDAD_MPS.has(estado)
}

function esEstadoMovimientoServidor(estado){
  return ESTADOS_MOVIMIENTO_SERVIDOR.has(
    typeof estado === "string" ? estado.trim() : ""
  )
}

function obtenerVelocidadMpsFallback(a){
  if(!a) return 0

  const velocidad = Number(a.velocidad)
  if(Number.isFinite(velocidad) && velocidad > 0){
    return estadoVelocidadEnMps(a.estado)
      ? velocidad
      : (velocidad * 0.514444)
  }

  const velocidadObjetivo = Number(a.velocidadObjetivo)
  if(Number.isFinite(velocidadObjetivo) && velocidadObjetivo > 0){
    return velocidadObjetivo * 0.514444
  }

  return 0
}

function obtenerPerfilDespegueAeronave(tipo){
  const clave = String(tipo || "").trim().toUpperCase()
  return TAKEOFF_PROFILES[clave] || TAKEOFF_PROFILE_BASE
}

function normalizarFaseDespegue(valor){
  const fase = String(valor || "").trim().toUpperCase()
  if(fase === "RUNWAY" || fase === "CLIMB"){
    return fase
  }
  return null
}

function obtenerProgresoCarreraDespegueMetros(aeronave){
  const progreso = Number(aeronave && aeronave.takeoffRollProgressM)
  return Number.isFinite(progreso) ? Math.max(0, progreso) : 0
}

function reiniciarSecuenciaDespegueAeronave(aeronave){
  if(!aeronave) return
  aeronave.fase = null
  aeronave.takeoffRollProgressM = 0
}

function registrarAvanceCarreraDespegue(aeronave, metrosRecorridos){
  if(!aeronave || normalizarFaseDespegue(aeronave.fase) !== "RUNWAY") return
  const incremento = Number(metrosRecorridos)
  if(!Number.isFinite(incremento) || incremento <= 0) return
  aeronave.takeoffRollProgressM =
    obtenerProgresoCarreraDespegueMetros(aeronave) + incremento
}

function calcularComandoDespegueAeronave(aeronave, segundosTick = 0.05){
  const perfil = obtenerPerfilDespegueAeronave(aeronave && aeronave.tipo)
  const deltaSegundos =
    Number.isFinite(segundosTick) && segundosTick > 0
      ? segundosTick
      : 0.05

  if(!aeronave || aeronave.estado !== "AIRBORNE"){
    return {
      activa: false,
      perfil,
      fase: null,
      velocidadObjetivoKt: perfil.CRUISE_MAX_KT,
      aceleracionKt: 0,
      climbFPM: 0,
      permitirAscenso: false,
      altitudObjetivoFt: perfil.DEFAULT_TARGET_ALT_FT
    }
  }

  const progresoRunwayM = obtenerProgresoCarreraDespegueMetros(aeronave)
  let fase = normalizarFaseDespegue(aeronave.fase)
  if(!fase && progresoRunwayM <= 0){
    return {
      activa: false,
      perfil,
      fase: null,
      velocidadObjetivoKt: perfil.CRUISE_MAX_KT,
      aceleracionKt: 0,
      climbFPM: 0,
      permitirAscenso: false,
      altitudObjetivoFt: perfil.DEFAULT_TARGET_ALT_FT
    }
  }

  const velocidadActualKt = Math.max(0, Number(aeronave.velocidad) || 0)
  const altitudActualFt = Math.max(0, Number(aeronave.altitud) || 0)
  if(!fase){
    fase = altitudActualFt > 1 ? "CLIMB" : "RUNWAY"
    aeronave.fase = fase
  }

  const altitudObjetivoRaw = Number(aeronave.altitudObjetivo)
  const altitudObjetivoFt =
    Number.isFinite(altitudObjetivoRaw) && altitudObjetivoRaw > 0
      ? altitudObjetivoRaw
      : perfil.DEFAULT_TARGET_ALT_FT

  if(fase === "CLIMB" && altitudActualFt >= (altitudObjetivoFt - 1)){
    reiniciarSecuenciaDespegueAeronave(aeronave)
    return {
      activa: false,
      perfil,
      fase: null,
      velocidadObjetivoKt: Number.isFinite(Number(aeronave.velocidadObjetivo))
        ? Math.max(0, Number(aeronave.velocidadObjetivo))
        : perfil.CRUISE_MAX_KT,
      aceleracionKt: 0,
      climbFPM: 0,
      permitirAscenso: false,
      altitudObjetivoFt
    }
  }

  if(fase === "RUNWAY"){
    const progresoNormalizado = Math.max(
      0,
      Math.min(1, progresoRunwayM / Math.max(1, perfil.RUNWAY_DISTANCE_M))
    )
    const aceleracionMps2 =
      perfil.RUNWAY_ACCEL_MAX_MPS2 -
      (
        (perfil.RUNWAY_ACCEL_MAX_MPS2 - perfil.RUNWAY_ACCEL_MIN_MPS2) *
        Math.pow(progresoNormalizado, 0.88)
      )
    const listoParaElevar =
      progresoRunwayM >= perfil.RUNWAY_DISTANCE_M &&
      velocidadActualKt >= (perfil.ROTATION_KT - 1)

    if(!listoParaElevar){
      return {
        activa: true,
        perfil,
        fase: "RUNWAY",
        velocidadObjetivoKt: perfil.RUNWAY_TARGET_KT,
        aceleracionKt: (aceleracionMps2 / 0.514444) * deltaSegundos,
        climbFPM: 0,
        permitirAscenso: false,
        altitudObjetivoFt
      }
    }

    aeronave.fase = "CLIMB"
    fase = "CLIMB"
  }

  const techoBajoFt = Math.min(perfil.FL050_FT, altitudObjetivoFt)
  const techoMedioFt = Math.min(perfil.FL150_FT, altitudObjetivoFt)
  const techoAltoFt = Math.min(perfil.FL240_FT, altitudObjetivoFt)

  let velocidadObjetivoKt = perfil.CRUISE_MAX_KT
  let climbFPM = 0

  if(altitudActualFt < techoBajoFt){
    velocidadObjetivoKt = perfil.SPEED_TO_FL050_KT
    climbFPM = perfil.ROC_TO_FL050_FPM
  } else if(altitudActualFt < techoMedioFt){
    velocidadObjetivoKt = perfil.SPEED_TO_FL150_KT
    climbFPM = perfil.ROC_TO_FL150_FPM
  } else if(altitudActualFt < techoAltoFt || altitudActualFt < altitudObjetivoFt){
    velocidadObjetivoKt = perfil.SPEED_TO_FL240_KT
    climbFPM = perfil.ROC_TO_FL240_FPM
  }

  return {
    activa: true,
    perfil,
    fase,
    velocidadObjetivoKt,
    aceleracionKt: perfil.CLIMB_ACCEL_KT_PER_SEC * deltaSegundos,
    climbFPM,
    permitirAscenso: climbFPM > 0,
    altitudObjetivoFt
  }
}

function aplicarPerformanceDespegueAeronave(aeronave, intervaloMS){
  const segundosTick = Math.max(0.02, (intervaloMS || 50) / 1000)
  const comandoDespegue = calcularComandoDespegueAeronave(aeronave, segundosTick)
  if(!comandoDespegue.activa){
    return false
  }

  const velocidadObjetivoKt = Number.isFinite(Number(comandoDespegue.velocidadObjetivoKt))
    ? Math.max(0, Number(comandoDespegue.velocidadObjetivoKt))
    : 0
  const aceleracionKt = Number.isFinite(Number(comandoDespegue.aceleracionKt))
    ? Math.max(0, Number(comandoDespegue.aceleracionKt))
    : 0
  const climbFPM = Number.isFinite(Number(comandoDespegue.climbFPM))
    ? Math.max(0, Number(comandoDespegue.climbFPM))
    : 0
  const altitudObjetivoFt = Number.isFinite(Number(comandoDespegue.altitudObjetivoFt))
    ? Math.max(0, Number(comandoDespegue.altitudObjetivoFt))
    : comandoDespegue.perfil.DEFAULT_TARGET_ALT_FT

  aeronave.velocidadObjetivo = velocidadObjetivoKt
  if(
    !Number.isFinite(Number(aeronave.altitudObjetivo)) ||
    Number(aeronave.altitudObjetivo) <= 0
  ){
    aeronave.altitudObjetivo = altitudObjetivoFt
  }

  const velocidadActualKt = Math.max(0, Number(aeronave.velocidad) || 0)
  if(velocidadActualKt < velocidadObjetivoKt){
    aeronave.velocidad = Math.min(velocidadObjetivoKt, velocidadActualKt + aceleracionKt)
  } else if(velocidadActualKt > velocidadObjetivoKt){
    aeronave.velocidad = Math.max(velocidadObjetivoKt, velocidadActualKt - aceleracionKt)
  } else {
    aeronave.velocidad = velocidadActualKt
  }

  if(comandoDespegue.permitirAscenso){
    const climbFtPorSegundo = climbFPM / 60
    const altitudActualFt = Math.max(0, Number(aeronave.altitud) || 0)
    aeronave.altitud = Math.min(
      altitudObjetivoFt,
      altitudActualFt + (climbFtPorSegundo * segundosTick)
    )
    if(aeronave.altitud >= (altitudObjetivoFt - 1)){
      aeronave.altitud = altitudObjetivoFt
      reiniciarSecuenciaDespegueAeronave(aeronave)
    }
  } else if(normalizarFaseDespegue(aeronave.fase) === "RUNWAY"){
    aeronave.altitud = 0
  }

  return true
}

function normalizarPuntoRuta(punto){
  if(Array.isArray(punto)){
    const lat = Number(punto[0])
    const lng = Number(punto[1])
    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { lat, lng }
  }
  if(punto && typeof punto === "object"){
    const lat = Number(punto.lat)
    const lng = Number(punto.lng)
    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { lat, lng }
  }
  return null
}

function normalizarRutaLineal(ruta){
  if(!Array.isArray(ruta)) return []
  const salida = []
  ruta.forEach(p => {
    const normalizado = normalizarPuntoRuta(p)
    if(!normalizado) return
    const ultimo = salida.length ? salida[salida.length - 1] : null
    if(
      ultimo &&
      Math.abs(ultimo.lat - normalizado.lat) < 1e-9 &&
      Math.abs(ultimo.lng - normalizado.lng) < 1e-9
    ){
      return
    }
    salida.push(normalizado)
  })
  return salida
}

function normalizarNombreProcedimientoLlegadaServidor(valor){
  if(typeof valor !== "string") return null
  const limpio = valor.trim()
  return limpio || null
}

function obtenerClaveProcedimientoLlegadaServidor(valor){
  const nombre = normalizarNombreProcedimientoLlegadaServidor(valor)
  if(!nombre){
    return ""
  }

  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
}

function normalizarIndiceLoopRutaAirborneServidor(valor){
  const indice = Number(valor)
  if(!Number.isFinite(indice)) return 0
  return Math.max(0, Math.floor(indice))
}

function normalizarAngulo360(valor){
  const num = Number(valor)
  if(!Number.isFinite(num)) return 0
  return ((num % 360) + 360) % 360
}

function aplicarVirajeLimitado(headingActual, headingObjetivo, maxCambioDeg){
  const actual = normalizarAngulo360(headingActual)
  const objetivo = normalizarAngulo360(headingObjetivo)
  const limite = Math.max(0, Number(maxCambioDeg) || 0)
  if(limite <= 0){
    return actual
  }
  const diff = diferenciaAngular(actual, objetivo)
  if(Math.abs(diff) <= limite){
    return objetivo
  }
  return normalizarAngulo360(actual + (Math.sign(diff) * limite))
}

function calcularTasaVirajeRealistaDegSeg(
  velocidadKnots,
  bancoMaxGrados,
  tasaMinDegSeg = PILOTAGE_REALISTIC_TURN_RATE_MIN_DEG_PER_SEC,
  tasaMaxDegSeg = PILOTAGE_REALISTIC_TURN_RATE_MAX_DEG_PER_SEC
){
  const velocidadMps = Math.max(1, Number(velocidadKnots) * 0.514444)
  const bancoRad = (Math.max(1, Number(bancoMaxGrados)) * Math.PI) / 180
  const tasaDegSeg =
    (9.80665 * Math.tan(bancoRad) / velocidadMps) * (180 / Math.PI)
  if(!Number.isFinite(tasaDegSeg)){
    return tasaMinDegSeg
  }
  return Math.max(tasaMinDegSeg, Math.min(tasaMaxDegSeg, tasaDegSeg))
}

function reiniciarGuiadoInterceptacionCircuito(aeronave){
  if(!aeronave) return
  aeronave.interceptTicks = 0
  aeronave.interceptHeadingRef = null
  aeronave.interceptTrackRefT = null
  aeronave.interceptSideRef = 0
  aeronave.interceptacionDirectaTramo = false
}

function obtenerLadoRelativoSegmento(posicion, A, B){
  if(!posicion || !A || !B){
    return 0
  }

  const latitudMediaRad =
    (((Number(posicion.lat) || 0) + (Number(A.lat) || 0) + (Number(B.lat) || 0)) / 3) *
    (Math.PI / 180)
  const escalaLng = Math.max(0.2, Math.cos(latitudMediaRad))
  const ABx = ((Number(B.lng) || 0) - (Number(A.lng) || 0)) * escalaLng
  const ABy = (Number(B.lat) || 0) - (Number(A.lat) || 0)
  const APx = ((Number(posicion.lng) || 0) - (Number(A.lng) || 0)) * escalaLng
  const APy = (Number(posicion.lat) || 0) - (Number(A.lat) || 0)
  const productoCruz = (ABx * APy) - (ABy * APx)

  if(!Number.isFinite(productoCruz) || Math.abs(productoCruz) < 1e-12){
    return 0
  }

  return productoCruz > 0 ? 1 : -1
}

function obtenerLadoInterceptacionEstable(aeronave, posicion, A, B, distanciaAlTramo){
  const ladoActual = obtenerLadoRelativoSegmento(posicion, A, B)
  const distancia =
    Number.isFinite(Number(distanciaAlTramo))
      ? Math.max(0, Number(distanciaAlTramo))
      : Infinity
  const ladoPrevio = Number.isFinite(Number(aeronave?.interceptSideRef))
    ? Math.sign(Number(aeronave.interceptSideRef))
    : 0

  if(distancia <= INTERCEPT_LEG_SIDE_NEUTRAL_DISTANCE_M){
    if(aeronave){
      aeronave.interceptSideRef = 0
    }
    return 0
  }

  if(ladoActual === 0){
    if(aeronave && ladoPrevio !== 0){
      aeronave.interceptSideRef = ladoPrevio
    }
    return ladoPrevio
  }

  if(
    ladoPrevio !== 0 &&
    ladoActual !== ladoPrevio &&
    distancia <= INTERCEPT_LEG_SIDE_HYSTERESIS_DISTANCE_M
  ){
    if(aeronave){
      aeronave.interceptSideRef = ladoPrevio
    }
    return ladoPrevio
  }

  if(aeronave){
    aeronave.interceptSideRef = ladoActual
  }

  return ladoActual
}

function obtenerProyeccionRutaLinealMasCercana(posicion, ruta){
  if(!posicion || !Array.isArray(ruta) || ruta.length < 2) return null
  let mejor = null

  for(let i = 1; i < ruta.length; i++){
    const A = ruta[i - 1]
    const B = ruta[i]
    const proyeccion = proyectarSobreSegmentoConFactor(posicion, A, B)
    const distancia = distanciaEntre(posicion, proyeccion.punto)
    const distanciaSegmento = distanciaEntre(A, B)

    if(!mejor || distancia < mejor.distancia){
      mejor = {
        distancia,
        indiceA: i - 1,
        progreso: distanciaSegmento * proyeccion.t,
        puntoIntercepto: proyeccion.punto
      }
    }
  }

  return mejor
}

function obtenerProyeccionRutaLinealMasCercanaDesdeIndice(
  posicion,
  ruta,
  indiceMinimo = 0
){
  if(!posicion || !Array.isArray(ruta) || ruta.length < 2){
    return null
  }

  const inicio = Math.max(
    1,
    Math.min(ruta.length - 1, Math.floor(Number(indiceMinimo) || 0) + 1)
  )
  let mejor = null

  for(let i = inicio; i < ruta.length; i++){
    const A = ruta[i - 1]
    const B = ruta[i]
    const proyeccion = proyectarSobreSegmentoConFactor(posicion, A, B)
    const distancia = distanciaEntre(posicion, proyeccion.punto)
    const distanciaSegmento = distanciaEntre(A, B)

    if(!mejor || distancia < mejor.distancia){
      mejor = {
        distancia,
        indiceA: i - 1,
        progreso: distanciaSegmento * proyeccion.t,
        puntoIntercepto: proyeccion.punto
      }
    }
  }

  return mejor
}

function calcularDistanciaAcumuladaRutaHasta(ruta, indiceSegmento, progresoSegmento = 0){
  if(!Array.isArray(ruta) || ruta.length < 2){
    return 0
  }

  const indiceRaw = Number(indiceSegmento)
  let distanciaTotal = 0

  if(Number.isFinite(indiceRaw) && indiceRaw >= ruta.length - 1){
    for(let i = 0; i < ruta.length - 1; i++){
      distanciaTotal += distanciaEntre(ruta[i], ruta[i + 1])
    }
    return distanciaTotal
  }

  const ultimoIndiceSegmento = Math.max(0, ruta.length - 2)
  const indice = Number.isFinite(indiceRaw)
    ? Math.max(0, Math.min(ultimoIndiceSegmento, Math.floor(indiceRaw)))
    : 0

  for(let i = 0; i < indice; i++){
    distanciaTotal += distanciaEntre(ruta[i], ruta[i + 1])
  }

  const A = ruta[indice]
  const B = ruta[indice + 1]
  if(A && B){
    const distanciaSegmento = distanciaEntre(A, B)
    const progreso = Number.isFinite(Number(progresoSegmento))
      ? Math.max(0, Math.min(distanciaSegmento, Number(progresoSegmento)))
      : 0
    distanciaTotal += progreso
  }

  return distanciaTotal
}

function obtenerRestriccionesPerfilAltitudLlegadaServidor(claveProcedimiento){
  if(claveProcedimiento === PROCEDIMIENTO_LLEGADA_GEBED3_HOLDING_MUMOP_CLAVE){
    return [
      { punto: ASOXI_COORDS_SERVIDOR, altitudFt: 8000 },
      { punto: GEBED_COORDS_SERVIDOR, altitudFt: 7000 },
      { punto: MUMOP_COORDS_SERVIDOR, altitudFt: 4000 }
    ]
  }

  if(
    claveProcedimiento === PROCEDIMIENTO_LLEGADA_ILS_U_CLAVE
  ){
    return [
      { punto: SCO_VOR_COORDS, altitudFt: 3000 },
      { punto: SCO_RADIAL_022_5NM_COORDS, altitudFt: 1600 },
      { punto: SILAM_COORDS_SERVIDOR, altitudFt: 1000 },
      { punto: TOUCHDOWN_ZONE_22_COORDS, altitudFt: 0 }
    ]
  }

  if(
    claveProcedimiento === PROCEDIMIENTO_LLEGADA_ILS_T_CLAVE
  ){
    return [
      { punto: SCO_VOR_COORDS, altitudFt: 3000 },
      { punto: SCO_RADIAL_017_8NM_COORDS, altitudFt: 1800 },
      { punto: KOLMI_COORDS_SERVIDOR, altitudFt: 1600 },
      { punto: TOUCHDOWN_ZONE_22_COORDS, altitudFt: 0 }
    ]
  }

  if(
    claveProcedimiento === PROCEDIMIENTO_LLEGADA_ILS_V_CLAVE ||
    claveProcedimiento === PROCEDIMIENTO_LLEGADA_VOR_V_CLAVE
  ){
    return [
      { punto: MUMOP_COORDS_SERVIDOR, altitudFt: 4000 },
      { punto: SCO_RADIAL_040_9NM_COORDS, altitudFt: 1800 },
      { punto: KOLMI_COORDS_SERVIDOR, altitudFt: 1600 },
      { punto: SCO_RADIAL_041_4NM_COORDS, altitudFt: 1280 },
      { punto: SCO_RADIAL_041_3NM_COORDS, altitudFt: 960 },
      { punto: SCO_RADIAL_041_2NM_COORDS, altitudFt: 650 },
      { punto: TOUCHDOWN_ZONE_22_COORDS, altitudFt: 0 }
    ]
  }

  if(claveProcedimiento === PROCEDIMIENTO_LLEGADA_VOR_U_CLAVE){
    return [
      { punto: SCO_VOR_COORDS, altitudFt: 3000 },
      { punto: SCO_RADIAL_022_5NM_COORDS, altitudFt: 1600 },
      { punto: SILAM_COORDS_SERVIDOR, altitudFt: 1000 },
      { punto: SCO_RADIAL_041_3NM_COORDS, altitudFt: 960 },
      { punto: SCO_RADIAL_041_2NM_COORDS, altitudFt: 650 },
      { punto: TOUCHDOWN_ZONE_22_COORDS, altitudFt: 0 }
    ]
  }

  if(claveProcedimiento === PROCEDIMIENTO_LLEGADA_VOR_T_CLAVE){
    return [
      { punto: SCO_VOR_COORDS, altitudFt: 3000 },
      { punto: SCO_RADIAL_017_8NM_COORDS, altitudFt: 1800 },
      { punto: KOLMI_COORDS_SERVIDOR, altitudFt: 1600 },
      { punto: SCO_RADIAL_041_4NM_COORDS, altitudFt: 1280 },
      { punto: SCO_RADIAL_041_3NM_COORDS, altitudFt: 960 },
      { punto: SCO_RADIAL_041_2NM_COORDS, altitudFt: 650 },
      { punto: TOUCHDOWN_ZONE_22_COORDS, altitudFt: 0 }
    ]
  }

  return []
}

function construirPerfilAltitudLlegadaServidor(aeronave){
  if(
    !aeronave ||
    !Array.isArray(aeronave.rutaAirborne) ||
    aeronave.rutaAirborne.length < 2
  ){
    return null
  }

  const claveProcedimiento = obtenerClaveProcedimientoLlegadaServidor(
    aeronave.arrivalProcedureName
  )
  const restricciones = obtenerRestriccionesPerfilAltitudLlegadaServidor(
    claveProcedimiento
  )
  if(!restricciones.length){
    return null
  }

  const ruta = aeronave.rutaAirborne
  const indiceActual = Number.isFinite(Number(aeronave.rutaAirborneIndice))
    ? Math.max(0, Math.floor(Number(aeronave.rutaAirborneIndice)))
    : 0
  const progresoActual = Number.isFinite(Number(aeronave.rutaAirborneProgreso))
    ? Math.max(0, Number(aeronave.rutaAirborneProgreso))
    : 0
  const altitudActual = Number.isFinite(Number(aeronave.altitud))
    ? Math.max(0, Number(aeronave.altitud))
    : 0

  const puntos = [
    {
      distanciaM: calcularDistanciaAcumuladaRutaHasta(
        ruta,
        indiceActual,
        progresoActual
      ),
      altitudFt: altitudActual
    }
  ]
  let indiceMinimo = Math.max(0, Math.min(ruta.length - 2, indiceActual))

  restricciones.forEach(restriccion => {
    const proyeccion = obtenerProyeccionRutaLinealMasCercanaDesdeIndice(
      restriccion.punto,
      ruta,
      indiceMinimo
    )
    if(!proyeccion){
      return
    }

    const distanciaM = calcularDistanciaAcumuladaRutaHasta(
      ruta,
      proyeccion.indiceA,
      proyeccion.progreso
    )
    const ultimoPunto = puntos[puntos.length - 1]

    if(distanciaM <= ultimoPunto.distanciaM + 1){
      ultimoPunto.distanciaM = Math.max(ultimoPunto.distanciaM, distanciaM)
      ultimoPunto.altitudFt = restriccion.altitudFt
    } else {
      puntos.push({
        distanciaM,
        altitudFt: restriccion.altitudFt
      })
    }

    indiceMinimo = Math.max(indiceMinimo, proyeccion.indiceA)
  })

  return puntos.length >= 2
    ? {
        claveProcedimiento,
        puntos
      }
    : null
}

function interpolarAltitudPerfilLlegadaServidor(perfil, distanciaActualM){
  const puntos = Array.isArray(perfil && perfil.puntos) ? perfil.puntos : []
  if(!puntos.length){
    return null
  }

  const distanciaActual = Number.isFinite(Number(distanciaActualM))
    ? Math.max(0, Number(distanciaActualM))
    : 0

  if(distanciaActual <= puntos[0].distanciaM){
    return puntos[0].altitudFt
  }

  for(let i = 1; i < puntos.length; i++){
    const inicio = puntos[i - 1]
    const fin = puntos[i]
    if(distanciaActual > fin.distanciaM){
      continue
    }

    const longitudTramo = Math.max(1, fin.distanciaM - inicio.distanciaM)
    const t = Math.max(
      0,
      Math.min(1, (distanciaActual - inicio.distanciaM) / longitudTramo)
    )
    return inicio.altitudFt + ((fin.altitudFt - inicio.altitudFt) * t)
  }

  return puntos[puntos.length - 1].altitudFt
}

function obtenerAltitudMinimaLoopPerfilLlegadaServidor(aeronave, perfil){
  if(
    !aeronave ||
    !perfil ||
    perfil.claveProcedimiento !== PROCEDIMIENTO_LLEGADA_GEBED3_HOLDING_MUMOP_CLAVE ||
    !Boolean(aeronave.rutaAirborneLoop) ||
    !Array.isArray(perfil.puntos) ||
    !perfil.puntos.length
  ){
    return null
  }

  const loopStartIndex = normalizarIndiceLoopRutaAirborneServidor(
    aeronave.rutaAirborneLoopStartIndex
  )
  const indiceActual = Number.isFinite(Number(aeronave.rutaAirborneIndice))
    ? Math.max(0, Math.floor(Number(aeronave.rutaAirborneIndice)))
    : 0
  if(indiceActual < loopStartIndex){
    return null
  }

  const altitudManualOverrideFt = Number(
    aeronave && aeronave.arrivalHoldingMumopManualAltitudeFt
  )
  if(Number.isFinite(altitudManualOverrideFt)){
    return Math.max(ALTITUD_MINIMA_HOLDING_MUMOP_FT, altitudManualOverrideFt)
  }

  const ultimoPunto = perfil.puntos[perfil.puntos.length - 1]
  const altitudLoopFt = Number(ultimoPunto && ultimoPunto.altitudFt)
  return Number.isFinite(altitudLoopFt)
    ? Math.max(ALTITUD_MINIMA_HOLDING_MUMOP_FT, altitudLoopFt)
    : null
}

function aplicarPerfilAltitudLlegadaServidor(aeronave, intervaloMS = 50){
  const perfil = aeronave && aeronave.arrivalAltitudeProfile
  if(
    !perfil ||
    !Array.isArray(perfil.puntos) ||
    perfil.puntos.length < 2 ||
    !Array.isArray(aeronave.rutaAirborne) ||
    aeronave.rutaAirborne.length < 2
  ){
    return false
  }

  const altitudLoopFt = obtenerAltitudMinimaLoopPerfilLlegadaServidor(
    aeronave,
    perfil
  )
  if(Number.isFinite(altitudLoopFt)){
    const altitudObjetivoFt = Math.max(0, Math.round(altitudLoopFt))
    aeronave.altitudObjetivo = altitudObjetivoFt
    ajustarAltitudHaciaObjetivo(aeronave)
    return true
  }

  const distanciaActualM = calcularDistanciaAcumuladaRutaHasta(
    aeronave.rutaAirborne,
    aeronave.rutaAirborneIndice,
    aeronave.rutaAirborneProgreso
  )
  const altitudPerfilFt = interpolarAltitudPerfilLlegadaServidor(
    perfil,
    distanciaActualM
  )
  if(!Number.isFinite(altitudPerfilFt)){
    return false
  }

  const altitudObjetivoFt = Math.max(0, Math.round(altitudPerfilFt))
  aeronave.altitudObjetivo = altitudObjetivoFt
  aeronave.altitud = altitudObjetivoFt
  return true
}

function avanzarRutaAirborneLineal(aeronave, intervaloMS){
  if(
    !aeronave ||
    !Array.isArray(aeronave.rutaAirborne) ||
    aeronave.rutaAirborne.length < 2
  ){
    return false
  }

  const ruta = aeronave.rutaAirborne
  const ultimoIndiceSegmento = Math.max(0, ruta.length - 2)
  const loopActivo =
    Boolean(aeronave.rutaAirborneLoop) &&
    ruta.length >= 2
  const loopStartIndex = loopActivo
    ? Math.max(
        0,
        Math.min(
          ultimoIndiceSegmento,
          normalizarIndiceLoopRutaAirborneServidor(aeronave.rutaAirborneLoopStartIndex)
        )
      )
    : 0
  let indice =
    Number.isFinite(aeronave.rutaAirborneIndice)
      ? Math.max(0, Math.min(ruta.length - 1, Math.floor(aeronave.rutaAirborneIndice)))
      : 0
  let progreso =
    Number.isFinite(aeronave.rutaAirborneProgreso)
      ? Math.max(0, aeronave.rutaAirborneProgreso)
      : 0

  if(loopActivo && indice >= ruta.length - 1){
    indice = loopStartIndex
    progreso = 0
  }

  const performanceDespegueAplicada = aplicarPerformanceDespegueAeronave(
    aeronave,
    intervaloMS
  )
  const velocidadMPS = obtenerVelocidadMpsFallback(aeronave)
  if(!Number.isFinite(velocidadMPS) || velocidadMPS <= 0){
    return false
  }

  const distanciaProgramadaM = velocidadMPS * (intervaloMS / 1000)
  let distanciaRestante = distanciaProgramadaM

  while(distanciaRestante > 0){
    if(indice >= ruta.length - 1){
      if(!loopActivo){
        break
      }
      indice = loopStartIndex
      progreso = 0
    }

    const A = ruta[indice]
    const B = ruta[indice + 1]
    const distanciaSegmento = Math.max(1, distanciaEntre(A, B))
    const restanteSegmento = Math.max(0, distanciaSegmento - progreso)

    if(distanciaRestante < restanteSegmento){
      progreso += distanciaRestante
      distanciaRestante = 0
      break
    }

    distanciaRestante -= restanteSegmento
    indice += 1
    progreso = 0

    if(loopActivo && indice >= ruta.length - 1){
      indice = loopStartIndex
    }
  }

  if(indice >= ruta.length - 1){
    if(loopActivo){
      indice = loopStartIndex
      progreso = 0
    } else {
      const ultimo = ruta[ruta.length - 1]
      const previo = ruta.length >= 2 ? ruta[ruta.length - 2] : ultimo
      const rumboFinal = calcularRumboServidor(previo, ultimo)
      const nuevoPunto =
        distanciaRestante > 0
          ? puntoPlano({ lat: ultimo.lat, lng: ultimo.lng }, rumboFinal, distanciaRestante)
          : { lat: ultimo.lat, lng: ultimo.lng }

      aeronave.lat = nuevoPunto.lat
      aeronave.lng = nuevoPunto.lng
      aeronave.angulo = rumboFinal
      aeronave.rutaAirborneFinalizada = true
      aeronave.rutaAirborneIndice = ruta.length - 1
      aeronave.rutaAirborneProgreso = 0
      registrarAvanceCarreraDespegue(aeronave, distanciaProgramadaM)
      if(
        !performanceDespegueAplicada &&
        !aplicarPerfilAltitudLlegadaServidor(aeronave, intervaloMS)
      ){
        ajustarAltitudHaciaObjetivo(aeronave, intervaloMS, {
          bloquearDescenso: aeronave.estado === "PILOTAGE"
        })
      }
      return true
    }
  }

  const A = ruta[indice]
  const B = ruta[indice + 1]
  const distanciaSegmento = Math.max(1, distanciaEntre(A, B))
  const t = Math.max(0, Math.min(1, progreso / distanciaSegmento))

  aeronave.lat = A.lat + (B.lat - A.lat) * t
  aeronave.lng = A.lng + (B.lng - A.lng) * t
  aeronave.angulo = calcularRumboServidor(A, B)
  aeronave.rutaAirborneFinalizada = false
  aeronave.rutaAirborneIndice = indice
  aeronave.rutaAirborneProgreso = progreso
  registrarAvanceCarreraDespegue(aeronave, distanciaProgramadaM)
  if(
    !performanceDespegueAplicada &&
    !aplicarPerfilAltitudLlegadaServidor(aeronave, intervaloMS)
  ){
    ajustarAltitudHaciaObjetivo(aeronave, intervaloMS, {
      bloquearDescenso: aeronave.estado === "PILOTAGE"
    })
  }

  return true
}

function ajustarAltitudHaciaObjetivo(aeronave, intervaloMS, opciones = {}){
  if(!aeronave) return
  const objetivoRaw = Number(aeronave.altitudObjetivo)
  if(!Number.isFinite(objetivoRaw)) return
  const objetivo = Math.max(0, objetivoRaw)
  const altitudActual = Number.isFinite(aeronave.altitud) ? aeronave.altitud : 0
  const delta = objetivo - altitudActual
  const bloquearDescenso = Boolean(opciones && opciones.bloquearDescenso)
  if(Math.abs(delta) < 1){
    aeronave.altitud = objetivo
    return
  }
  if(delta < 0 && bloquearDescenso){
    return
  }
  const tasaFpm = delta > 0
    ? (CLIMB_RATE[aeronave.tipo] || 2000)
    : (DESCENT_RATE[aeronave.tipo] || 1500)
  const segundos = Math.max(0.02, (intervaloMS || 50) / 1000)
  const cambio = (tasaFpm / 60) * segundos
  if(delta > 0){
    aeronave.altitud = Math.min(objetivo, altitudActual + cambio)
  } else {
    aeronave.altitud = Math.max(objetivo, altitudActual - cambio)
  }
}

function avanzarMovimientoHacia(aeronave, movimiento, intervaloMS){
  if(!aeronave || !movimiento) return { completado: false }

  const destino = normalizarPuntoRuta(movimiento.destino)
  if(!destino) return { completado: true }

  const posicionActual = { lat: aeronave.lat, lng: aeronave.lng }
  const distancia = distanciaEntre(posicionActual, destino)
  if(!Number.isFinite(distancia)){
    return { completado: true }
  }

  const opciones = movimiento.opciones || {}
  const descensoProgresivo = Boolean(opciones.descensoProgresivo)
  const aplicarAceleracionProgresiva = Boolean(opciones.aplicarAceleracionProgresiva)
  const velocidadObjetivoFinalKt = Number.isFinite(Number(opciones.velocidadObjetivoFinalKt))
    ? Math.max(0, Number(opciones.velocidadObjetivoFinalKt))
    : Math.max(0, Number(aeronave.velocidadObjetivo) || PILOTAGE_DEFAULT_SPEED_INITIAL_KT)
  const aceleracionKnotsPorSegundo = Number.isFinite(Number(opciones.aceleracionKnotsPorSegundo))
    ? Math.max(0, Number(opciones.aceleracionKnotsPorSegundo))
    : 0
  const rumboFijo = Number(opciones.rumboFijo)
  const usarRumboFijo = Number.isFinite(rumboFijo)
  const umbralCongelarRumboM = Number.isFinite(Number(opciones.umbralCongelarRumboM))
    ? Math.max(0, Number(opciones.umbralCongelarRumboM))
    : 8
  const virajeRealista = Boolean(opciones.virajeRealista)
  const bancoMaxGrados = Number.isFinite(Number(opciones.bancoMaxGrados))
    ? Math.max(1, Number(opciones.bancoMaxGrados))
    : PILOTAGE_REALISTIC_BANK_DEG
  const tasaVirajeMinDegSeg = Number.isFinite(Number(opciones.tasaVirajeMinDegSeg))
    ? Math.max(0.2, Number(opciones.tasaVirajeMinDegSeg))
    : PILOTAGE_REALISTIC_TURN_RATE_MIN_DEG_PER_SEC
  const tasaVirajeMaxDegSeg = Number.isFinite(Number(opciones.tasaVirajeMaxDegSeg))
    ? Math.max(
        tasaVirajeMinDegSeg,
        Number(opciones.tasaVirajeMaxDegSeg)
      )
    : PILOTAGE_REALISTIC_TURN_RATE_MAX_DEG_PER_SEC
  const altitudInicialDescenso = Number.isFinite(Number(opciones.altitudInicial))
    ? Math.max(0, Number(opciones.altitudInicial))
    : Math.max(0, Number(aeronave.altitud) || 0)
  const altitudObjetivoDescenso = Number.isFinite(Number(opciones.altitudObjetivo))
    ? Math.max(0, Number(opciones.altitudObjetivo))
    : 0

  const deltaSegundos = Math.max(0.02, (intervaloMS || 50) / 1000)

  if(descensoProgresivo && !Number.isFinite(movimiento.distanciaInicialDescenso)){
    movimiento.distanciaInicialDescenso = Math.max(1, distancia)
  }
  if(descensoProgresivo && !Number.isFinite(movimiento.altitudInicialDescenso)){
    movimiento.altitudInicialDescenso = altitudInicialDescenso
  }

  let velocidadKnotsActual = Number(movimiento.velocidadActualKt)
  if(!Number.isFinite(velocidadKnotsActual) || velocidadKnotsActual <= 0){
    const velObjetivo = Number(aeronave.velocidadObjetivo)
    if(Number.isFinite(velObjetivo) && velObjetivo > 0){
      velocidadKnotsActual = velObjetivo
    } else if(Number.isFinite(aeronave.velocidad) && aeronave.velocidad > 0){
      velocidadKnotsActual = aeronave.velocidad / 0.514444
    } else {
      velocidadKnotsActual = PILOTAGE_DEFAULT_SPEED_INITIAL_KT
    }
  }

  if(aplicarAceleracionProgresiva && movimiento.speedAutoActiva !== false){
    const velocidadBaseKt = velocidadKnotsActual
    const siguienteVelocidadKt = Math.min(
      velocidadObjetivoFinalKt,
      velocidadBaseKt + (aceleracionKnotsPorSegundo * deltaSegundos)
    )
    velocidadKnotsActual = siguienteVelocidadKt
    movimiento.velocidadActualKt = siguienteVelocidadKt
    if(siguienteVelocidadKt >= velocidadObjetivoFinalKt){
      movimiento.speedAutoActiva = false
    }
  }

  const velocidadKnots = Math.max(0, velocidadKnotsActual || velocidadObjetivoFinalKt || 0)
  aeronave.velocidadObjetivo = velocidadKnots
  aeronave.velocidad = velocidadKnots * 0.514444

  const tasaVirajeDegSeg = virajeRealista
    ? calcularTasaVirajeRealistaDegSeg(
        velocidadKnots,
        bancoMaxGrados,
        tasaVirajeMinDegSeg,
        tasaVirajeMaxDegSeg
      )
    : null
  const maxCambioRumboDeg = virajeRealista
    ? Math.max(0, tasaVirajeDegSeg * deltaSegundos)
    : 0

  if(usarRumboFijo){
    const headingActual = normalizarAngulo360(
      Number(aeronave.angulo) || Number(rumboFijo)
    )
    aeronave.angulo = virajeRealista
      ? aplicarVirajeLimitado(headingActual, rumboFijo, maxCambioRumboDeg)
      : normalizarAngulo360(rumboFijo)
  } else if(distancia > umbralCongelarRumboM){
    const rumboDestino = calcularRumboServidor(posicionActual, destino)
    if(Number.isFinite(rumboDestino)){
      const headingActual = normalizarAngulo360(
        Number(aeronave.angulo) || Number(rumboDestino)
      )
      aeronave.angulo = virajeRealista
        ? aplicarVirajeLimitado(headingActual, rumboDestino, maxCambioRumboDeg)
        : normalizarAngulo360(rumboDestino)
    }
  }

  const metrosPorSegundo = velocidadKnots * 0.514444
  const paso = Math.min(metrosPorSegundo * deltaSegundos, distancia)
  const umbralLlegadaM = virajeRealista
    ? Math.max(2, paso * 1.4)
    : 2

  if(distancia <= umbralLlegadaM){
    aeronave.lat = destino.lat
    aeronave.lng = destino.lng
    if(descensoProgresivo){
      aeronave.altitud = altitudObjetivoDescenso
    }
    return { completado: true }
  }

  let nuevaLat = posicionActual.lat
  let nuevaLng = posicionActual.lng

  if(virajeRealista){
    let headingMovimiento = Number(aeronave.angulo)
    if(!Number.isFinite(headingMovimiento)){
      if(usarRumboFijo){
        headingMovimiento = normalizarAngulo360(rumboFijo)
      } else {
        const rumboHaciaDestino = calcularRumboServidor(posicionActual, destino)
        headingMovimiento = Number.isFinite(rumboHaciaDestino)
          ? rumboHaciaDestino
          : 0
      }
    }

    const puntoAdelante = puntoPlano(
      { lat: posicionActual.lat, lng: posicionActual.lng },
      normalizarAngulo360(headingMovimiento),
      paso
    )
    const latCalculada = Number(puntoAdelante && puntoAdelante.lat)
    const lngCalculada = Number(puntoAdelante && puntoAdelante.lng)
    if(Number.isFinite(latCalculada) && Number.isFinite(lngCalculada)){
      nuevaLat = latCalculada
      nuevaLng = lngCalculada
    } else {
      const ratio = paso / Math.max(1, distancia)
      nuevaLat = posicionActual.lat + (destino.lat - posicionActual.lat) * ratio
      nuevaLng = posicionActual.lng + (destino.lng - posicionActual.lng) * ratio
    }

    const distanciaPosterior = distanciaEntre(
      { lat: nuevaLat, lng: nuevaLng },
      destino
    )
    if(distanciaPosterior <= umbralLlegadaM){
      aeronave.lat = destino.lat
      aeronave.lng = destino.lng
      if(descensoProgresivo){
        aeronave.altitud = altitudObjetivoDescenso
      }
      return { completado: true }
    }
  } else {
    const ratio = paso / Math.max(1, distancia)
    nuevaLat = posicionActual.lat + (destino.lat - posicionActual.lat) * ratio
    nuevaLng = posicionActual.lng + (destino.lng - posicionActual.lng) * ratio
  }

  aeronave.lat = nuevaLat
  aeronave.lng = nuevaLng

  if(descensoProgresivo){
    const distanciaInicial = Math.max(
      1,
      Number(movimiento.distanciaInicialDescenso) || distancia
    )
    const ratioDistancia = Math.max(0, Math.min(1, distancia / distanciaInicial))
    const altitudBase = Number(movimiento.altitudInicialDescenso)
    const altitudInicial = Number.isFinite(altitudBase)
      ? altitudBase
      : altitudInicialDescenso
    aeronave.altitud = Math.max(
      0,
      altitudObjetivoDescenso +
        ((altitudInicial - altitudObjetivoDescenso) * ratioDistancia)
    )
  }

  return { completado: false }
}

function resincronizarRutaAirborneDesdePos(aeronave){
  if(
    !aeronave ||
    !Array.isArray(aeronave.rutaAirborne) ||
    aeronave.rutaAirborne.length < 2
  ){
    return false
  }

  const posicionActual = { lat: aeronave.lat, lng: aeronave.lng }
  const proyeccion = obtenerProyeccionRutaLinealMasCercana(
    posicionActual,
    aeronave.rutaAirborne
  )
  if(!proyeccion){
    return false
  }

  aeronave.rutaAirborneIndice = proyeccion.indiceA
  aeronave.rutaAirborneProgreso = proyeccion.progreso
  return true
}

function normalizarSentidoOrbitTexto(valor) {
  if (typeof valor === "number" && Number.isFinite(valor)) {
    return valor < 0 ? "LEFT" : "RIGHT"
  }

  const texto = typeof valor === "string" ? valor.trim().toUpperCase() : ""
  if (texto === "LEFT" || texto === "L" || texto === "IZQUIERDA") {
    return "LEFT"
  }
  return "RIGHT"
}

function normalizarTipoMarcaPilotageServidor(valor) {
  const texto = typeof valor === "string" ? valor.trim().toLowerCase() : ""
  if (texto === "orbit" || texto === "pilotage") {
    return texto
  }
  return null
}

function normalizarObjetivoPilotageServidor(lat, lng) {
  const latNum = Number(lat)
  const lngNum = Number(lng)
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return null
  }
  return { lat: latNum, lng: lngNum }
}

function actualizarObjetivoPilotageServidor(aeronave, data = {}) {
  if (!aeronave || !data || typeof data !== "object") return

  const tieneLat = Object.prototype.hasOwnProperty.call(data, "pilotageObjetivoLat")
  const tieneLng = Object.prototype.hasOwnProperty.call(data, "pilotageObjetivoLng")
  const tieneTipo = Object.prototype.hasOwnProperty.call(data, "pilotageMarkerTipo")

  if (!tieneLat && !tieneLng && !tieneTipo) {
    return
  }

  if (tieneTipo) {
    aeronave.pilotageMarkerTipo =
      normalizarTipoMarcaPilotageServidor(data.pilotageMarkerTipo)
  }

  if (tieneLat || tieneLng) {
    const objetivo = normalizarObjetivoPilotageServidor(
      data.pilotageObjetivoLat,
      data.pilotageObjetivoLng
    )
    aeronave.pilotageObjetivoLat = objetivo ? objetivo.lat : null
    aeronave.pilotageObjetivoLng = objetivo ? objetivo.lng : null
  }

  if (
    aeronave.pilotageMarkerTipo !== "orbit" ||
    !Number.isFinite(Number(aeronave.pilotageObjetivoLat)) ||
    !Number.isFinite(Number(aeronave.pilotageObjetivoLng))
  ) {
    aeronave.pilotageMarkerTipo = null
    aeronave.pilotageObjetivoLat = null
    aeronave.pilotageObjetivoLng = null
  }
}

function normalizarSentidoCircuitoTexto(valor) {
  if (typeof valor === "number" && Number.isFinite(valor)) {
    return valor < 0 ? "LEFT" : "RIGHT"
  }

  const texto = typeof valor === "string" ? valor.trim().toUpperCase() : ""
  if (texto === "RIGHT" || texto === "R" || texto === "DERECHA") {
    return "RIGHT"
  }
  return "LEFT"
}

function obtenerRumbosCircuito(valor = null) {
  const sentidoNormalizado =
    valor && typeof valor === "object"
      ? normalizarSentidoCircuitoTexto(valor.circuitoSentido)
      : normalizarSentidoCircuitoTexto(valor)

  return sentidoNormalizado === "RIGHT"
    ? RUMBOS_CIRCUITO_DERECHA
    : RUMBOS_CIRCUITO
}

function esCircuitoDerecha(aeronave) {
  return normalizarSentidoCircuitoTexto(aeronave?.circuitoSentido) === "RIGHT"
}

function obtenerSignoSentidoOrbit(valor) {
  return normalizarSentidoOrbitTexto(valor) === "LEFT"
    ? ORBIT_SENTIDO_IZQUIERDA
    : ORBIT_SENTIDO_DERECHA
}
function obtenerVelocidadMPSParaRuta(a, fallbackMps = GO_AROUND_SPEED_DEFAULT_KT * 0.514444) {
  if (a && typeof a.velocidadObjetivo === "number" && Number.isFinite(a.velocidadObjetivo)) {
    return Math.max(0, a.velocidadObjetivo) * 0.514444
  }
  if (a && typeof a.velocidad === "number" && Number.isFinite(a.velocidad)) {
    return Math.max(0, a.velocidad)
  }
  return fallbackMps
}
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
const INTERCEPT_ARC_DIRECT_TO_LEG_DISTANCE_M = 170
const INTERCEPT_ARC_CAPTURE_DISTANCE_M = 105
const INTERCEPT_ARC_MAX_TURN_FAR_DEG = 0.7
const INTERCEPT_ARC_MAX_TURN_NEAR_DEG = 1.05
const INTERCEPT_LEG_MIN_INTERCEPT_ANGLE_DEG = 4
const INTERCEPT_LEG_MAX_INTERCEPT_ANGLE_DEG = 32
const INTERCEPT_LEG_SOFT_CAPTURE_DISTANCE_M = 90
const INTERCEPT_LEG_SOFT_CAPTURE_HEADING_DEG = 16
const INTERCEPT_LEG_SOFT_CAPTURE_MIN_TICKS = 6
const INTERCEPT_LEG_FINAL_ALIGN_DISTANCE_M = 55
const INTERCEPT_LEG_SIDE_NEUTRAL_DISTANCE_M = 18
const INTERCEPT_LEG_SIDE_HYSTERESIS_DISTANCE_M = 34
const INTERCEPT_DIRECT_TO_LEG_ALIGN_DISTANCE_M = 260
const INTERCEPT_DIRECT_TO_LEG_HEADING_SMOOTH_FACTOR = 0.42
const INTERCEPT_DIRECT_TO_LEG_MAX_TURN_FAR_DEG = 2.2
const INTERCEPT_DIRECT_TO_LEG_MAX_TURN_NEAR_DEG = 3.6
const INTERCEPT_DIRECT_TO_LEG_CAPTURE_DISTANCE_M = 60


function convertirHoraASegundos(horaStr) {
  const [h, m, s] = horaStr.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function convertirHoraObjetoASegundos(horaObj) {
  if (!horaObj) return null;

  const horas = Number.parseInt(horaObj.horas, 10);
  const minutos = Number.parseInt(horaObj.minutos, 10);
  const segundos = Number.parseInt(horaObj.segundos, 10);

  if (
    !Number.isFinite(horas) ||
    !Number.isFinite(minutos) ||
    !Number.isFinite(segundos)
  ) {
    return null;
  }

  return (horas * 3600) + (minutos * 60) + segundos;
}

function generarLetraAleatoriaAZ() {
  const codigo = 65 + Math.floor(Math.random() * 26);
  return String.fromCharCode(codigo);
}

function formatearHora(segundosTotales) {
  segundosTotales = Math.floor(segundosTotales % 86400);

  const h = Math.floor(segundosTotales / 3600).toString().padStart(2, "0");
  const m = Math.floor((segundosTotales % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(segundosTotales % 60).toString().padStart(2, "0");

  return { horas: h, minutos: m, segundos: s };
}

function horaObjetoATexto(horaObj) {
  if (!horaObj) return null;

  const horas = String(horaObj.horas ?? "00").padStart(2, "0");
  const minutos = String(horaObj.minutos ?? "00").padStart(2, "0");
  const segundos = String(horaObj.segundos ?? "00").padStart(2, "0");

  return horas + ":" + minutos + ":" + segundos;
}


function obtenerListaSalas() {
  return Object.keys(salas).map(nombre => ({
    nombre,
    jugadores: salas[nombre].jugadores.length
  }));
}

function socketPuedeControlarAeronave(salaNombre, sala, aeronave, socketId) {
  if(!sala || !aeronave) return false
  return modosOperacionPorSocket.get(socketId) === "piloto"
}

function normalizarDatosCreacionAeronave(data = {}) {
  const lat = Number(data.lat)
  const lng = Number(data.lng)
  const altitud = Number(data.altitud)
  const angulo = Number(data.angulo)

  return {
    id: typeof data.id === "string" ? data.id.trim() : String(data.id || "").trim(),
    tipo: typeof data.tipo === "string" ? data.tipo.trim() : String(data.tipo || "").trim(),
    lat: Number.isFinite(lat) ? lat : 0,
    lng: Number.isFinite(lng) ? lng : 0,
    altitud: Number.isFinite(altitud) ? altitud : 0,
    angulo: Number.isFinite(angulo) ? angulo : 0
  }
}

function crearRegistroAeronave(dataInicial = {}, opciones = {}) {
  const base = normalizarDatosCreacionAeronave(dataInicial)

  return {
    id: base.id,
    owner: Object.prototype.hasOwnProperty.call(opciones, "owner")
      ? opciones.owner
      : null,
    tipo: base.tipo,
    lat: base.lat,
    lng: base.lng,
    altitud: base.altitud,
    angulo: base.angulo,
    velocidad: 0,
    velocidadObjetivo: 0,
    altitudObjetivo: null,
    orbitPendiente: false,
    orbitEnCurso: false,
    orbitModoContinuo: false,
    orbitDetenerSolicitado: false,
    orbitSentido: "RIGHT",
    circuitoSentido: "LEFT",
    shortCircuitoActivo: false,
    extensionUpwindExtraLocal: 0,
    extensionDownwindExtraLocal: 0,
    altitudCircuitoAutomaticaActiva: false,
    ingresoDownwindWaypoints: null,
    ingresoDownwindTipo: null,
    interceptTrackRefT: null,
    interceptSideRef: 0,
    interceptacionDirectaTramo: false,
    ruta: null,
    indice: 0,
    progreso: 0,
    indiceObjetivo: null,
    tramoObjetivo: null,
    puntoIntercepto: null,
    rutaAirborne: null,
    rutaAirborneFinalizada: false,
    rutaAirborneIndice: 0,
    rutaAirborneProgreso: 0,
    rutaAirborneLoop: false,
    rutaAirborneLoopStartIndex: 0,
    fase: null,
    takeoffRollProgressM: 0,
    arrivalProcedureName: null,
    arrivalAltitudeProfile: null,
    arrivalHoldingMumopManualAltitudeFt: null,
    pilotageObjetivoLat: null,
    pilotageObjetivoLng: null,
    pilotageMarkerTipo: null,
    syncTs: null,
    estado: "IDLE"
  }
}

function construirPayloadActualizacionAeronave(aeronave, extras = {}) {
  return {
    id: aeronave.id,
    lat: aeronave.lat,
    lng: aeronave.lng,
    altitud: aeronave.altitud,
    altitudObjetivo: Number.isFinite(Number(aeronave.altitudObjetivo))
      ? Math.max(0, Number(aeronave.altitudObjetivo))
      : null,
    angulo: aeronave.angulo,
    velocidad: aeronave.velocidad,
    velocidadObjetivo: aeronave.velocidadObjetivo,
    estado: aeronave.estado,
    pilotageObjetivoLat: Number.isFinite(Number(aeronave.pilotageObjetivoLat))
      ? Number(aeronave.pilotageObjetivoLat)
      : null,
    pilotageObjetivoLng: Number.isFinite(Number(aeronave.pilotageObjetivoLng))
      ? Number(aeronave.pilotageObjetivoLng)
      : null,
    pilotageMarkerTipo: normalizarTipoMarcaPilotageServidor(aeronave.pilotageMarkerTipo),
    orbitSentido: normalizarSentidoOrbitTexto(aeronave.orbitSentido),
    shortCircuitoActivo: Boolean(aeronave.shortCircuitoActivo),
    circuitoSentido: normalizarSentidoCircuitoTexto(aeronave.circuitoSentido),
    extensionAeronave: {
      upwind: Number.isFinite(Number(aeronave.extensionUpwindExtraLocal))
        ? Number(aeronave.extensionUpwindExtraLocal)
        : 0,
      downwind: Number.isFinite(Number(aeronave.extensionDownwindExtraLocal))
        ? Number(aeronave.extensionDownwindExtraLocal)
        : 0
    },
    arrivalProcedureName: normalizarNombreProcedimientoLlegadaServidor(
      aeronave.arrivalProcedureName
    ),
    rutaAirborne: Array.isArray(aeronave.rutaAirborne)
      ? normalizarRutaLineal(aeronave.rutaAirborne)
      : null,
    rutaAirborneIndice: Number.isFinite(Number(aeronave.rutaAirborneIndice))
      ? Math.max(0, Math.floor(Number(aeronave.rutaAirborneIndice)))
      : 0,
    rutaAirborneProgreso: Number.isFinite(Number(aeronave.rutaAirborneProgreso))
      ? Math.max(0, Number(aeronave.rutaAirborneProgreso))
      : 0,
    rutaAirborneLoop: Boolean(aeronave.rutaAirborneLoop),
    rutaAirborneLoopStartIndex: normalizarIndiceLoopRutaAirborneServidor(
      aeronave.rutaAirborneLoopStartIndex
    ),
    fase:
      aeronave.estado === "AIRBORNE"
        ? normalizarFaseDespegue(aeronave.fase)
        : null,
    takeoffRollProgressM:
      aeronave.estado === "AIRBORNE"
        ? obtenerProgresoCarreraDespegueMetros(aeronave)
        : 0,
    syncTs: Number.isFinite(Number(aeronave.syncTs))
      ? Number(aeronave.syncTs)
      : null,
    ...extras
  }
}

function detenerAccionActualAeronave(aeronave) {
  if(!aeronave) return null

  limpiarGoAroundAeronave(aeronave)
  limpiarOrbitacionAeronave(aeronave)
  limpiarDescensoClearedToLandBase(aeronave)
  reiniciarGuiadoInterceptacionCircuito(aeronave)

  aeronave.estado = "IDLE"
  aeronave.velocidad = 0
  aeronave.velocidadObjetivo = 0
  aeronave.altitudObjetivo = null
  aeronave.altitudCircuitoAutomaticaActiva = false
  aeronave.shortCircuitoActivo = false
  aeronave.extensionUpwindExtraLocal = 0
  aeronave.extensionDownwindExtraLocal = 0
  aeronave.ruta = null
  aeronave.indice = 0
  aeronave.progreso = 0
  aeronave.indiceObjetivo = null
  aeronave.tramoObjetivo = null
  aeronave.puntoIntercepto = null
  aeronave.ingresoDownwindWaypoints = null
  aeronave.ingresoDownwindTipo = null
  aeronave.movimiento = null
  aeronave.puntoIngreso = null
  aeronave.rutaAirborne = null
  aeronave.rutaAirborneFinalizada = false
  aeronave.rutaAirborneIndice = 0
  aeronave.rutaAirborneProgreso = 0
  aeronave.rutaAirborneLoop = false
  aeronave.rutaAirborneLoopStartIndex = 0
  aeronave.fase = null
  aeronave.takeoffRollProgressM = 0
  aeronave.arrivalProcedureName = null
  aeronave.arrivalAltitudeProfile = null
  aeronave.arrivalHoldingMumopManualAltitudeFt = null
  aeronave.syncTs = Date.now()
  return aeronave
}

function circuitoTieneDimensionesOriginales(sala, aeronave) {
  if (!sala || !aeronave) return false

  const base = obtenerExtensionesBaseSala(sala)
  const extraUpwindLocal =
    typeof aeronave.extensionUpwindExtraLocal === "number"
      ? aeronave.extensionUpwindExtraLocal
      : 0
  const extraDownwindLocal =
    typeof aeronave.extensionDownwindExtraLocal === "number"
      ? aeronave.extensionDownwindExtraLocal
      : 0

  return (
    !Boolean(aeronave.shortCircuitoActivo) &&
    base.upwind === 0 &&
    base.downwind === 0 &&
    extraUpwindLocal === 0 &&
    extraDownwindLocal === 0
  )
}

function restablecerCircuitoOriginalAlCruzarUmbral22(nombreSala, sala, aeronave) {
  if (!nombreSala || !sala || !aeronave || !tieneExtensionLocalAeronave(aeronave)) {
    return false
  }

  aeronave.shortCircuitoActivo = false
  aeronave.extensionUpwindExtraLocal = 0
  aeronave.extensionDownwindExtraLocal = 0

  const rutaCircuitoBase = generarRutaServidorParaAeronave(sala, aeronave)
  if (!Array.isArray(rutaCircuitoBase) || rutaCircuitoBase.length < 2) {
    return false
  }

  reajustarAeronaveEnRuta(aeronave, rutaCircuitoBase)

  io.to(nombreSala).emit("rutaCircuitoActualizada", {
    id: aeronave.id,
    ruta: rutaCircuitoBase,
    sentidoCircuito: normalizarSentidoCircuitoTexto(aeronave.circuitoSentido),
    shortCircuitoActivo: false,
    extensionAeronave: {
      upwind: 0,
      downwind: 0
    }
  })

  return true
}

function limpiarOrbitacionAeronave(aeronave) {
  if (!aeronave) return

  if (typeof aeronave.orbitSentido !== "string") {
    aeronave.orbitSentido = "RIGHT"
  }

  aeronave.orbitPendiente = false
  aeronave.orbitEnCurso = false
  aeronave.orbitModoContinuo = false
  aeronave.orbitDetenerSolicitado = false
  aeronave.orbitCentro = null
  aeronave.orbitRadio = null
  aeronave.orbitBearing = null
  aeronave.orbitAcumulado = 0
  aeronave.orbitFueraCircuitoActivo = false
}

function activarOrbitacionFueraCircuitoServidor(sala, aeronave, sentido) {
  if (!sala || !aeronave) return false

  if (!aeronave.ruta || aeronave.ruta.length < 2) {
    aeronave.ruta = generarRutaServidorParaAeronave(sala, aeronave)
  }
  if (!aeronave.ruta || aeronave.ruta.length < 2) {
    return false
  }

  limpiarOrbitacionAeronave(aeronave)

  const proyeccionInicial = obtenerProyeccionRutaMasCercana(
    { lat: aeronave.lat, lng: aeronave.lng },
    aeronave.ruta
  )
  if (proyeccionInicial) {
    aeronave.indice = proyeccionInicial.indiceA
    aeronave.progreso = proyeccionInicial.progreso
  }

  aeronave.orbitSentido = normalizarSentidoOrbitTexto(sentido)
  aeronave.orbitPendiente = false
  aeronave.orbitEnCurso = true
  aeronave.orbitModoContinuo = true
  aeronave.orbitDetenerSolicitado = false
  aeronave.orbitAcumulado = 0
  aeronave.orbitFueraCircuitoActivo = true
  aeronave.estado = "ORBT"

  if (!Number.isFinite(aeronave.angulo)) {
    aeronave.angulo = RUMBOS_CIRCUITO.downwind
  }
  if (!Number.isFinite(aeronave.velocidad) || aeronave.velocidad <= 0) {
    aeronave.velocidad = 90 * 0.514444
  }

  return true
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

function limpiarDescensoClearedToLandBase(aeronave) {
  if (!aeronave) return
  aeronave.clearedBaseDescensoActivo = false
  aeronave.clearedBaseAltitudInicioFt = null
  aeronave.clearedBaseDistanciaTotalM = null
}

function calcularDistanciaRestanteBase(aeronave) {
  if (!aeronave || !Array.isArray(aeronave.ruta) || aeronave.ruta.length < 2) {
    return null
  }

  const ruta = aeronave.ruta
  const totalPuntos = ruta.length
  const indiceActual =
    Number.isFinite(aeronave.indice)
      ? ((aeronave.indice % totalPuntos) + totalPuntos) % totalPuntos
      : 0
  const progresoActual = Number.isFinite(aeronave.progreso)
    ? Math.max(0, aeronave.progreso)
    : 0

  const A = ruta[indiceActual]
  const indiceB = (indiceActual - 1 + totalPuntos) % totalPuntos
  const B = ruta[indiceB]
  if (!A || !B) return null

  const rumboActual = calcularRumboServidor(A, B)
  const tipoActual = obtenerTipoSegmentoRuta(A, B, rumboActual)
  if (tipoActual !== "base") return 0

  const distanciaSegmentoActual = distanciaEntre(A, B)
  let restante = Math.max(0, distanciaSegmentoActual - progresoActual)

  let cursor = indiceB
  let guard = 0

  while (guard < totalPuntos) {
    const ACursor = ruta[cursor]
    const indiceSiguiente = (cursor - 1 + totalPuntos) % totalPuntos
    const BCursor = ruta[indiceSiguiente]
    if (!ACursor || !BCursor) break

    const rumboCursor = calcularRumboServidor(ACursor, BCursor)
    const tipoCursor = obtenerTipoSegmentoRuta(ACursor, BCursor, rumboCursor)
    if (tipoCursor !== "base") break

    restante += distanciaEntre(ACursor, BCursor)
    cursor = indiceSiguiente
    guard += 1
  }

  return restante
}

function redirigirAeronaveAlCircuitoMasCercano(aeronave, rutaNueva) {
  if (!aeronave || !Array.isArray(rutaNueva) || rutaNueva.length < 2) {
    return false
  }

  const proyeccionRuta = obtenerProyeccionRutaMasCercana(
    { lat: aeronave.lat, lng: aeronave.lng },
    rutaNueva
  )
  if (!proyeccionRuta) {
    return false
  }

  aeronave.ruta = rutaNueva
  aeronave.tramoObjetivo = proyeccionRuta.indiceA
  aeronave.puntoIntercepto = proyeccionRuta.puntoIntercepto
  aeronave.ingresoDownwindWaypoints = null
  aeronave.ingresoDownwindTipo = null
  aeronave.estado = "INTERCEPTING LEG"
  reiniciarGuiadoInterceptacionCircuito(aeronave)
  aeronave.interceptacionDirectaTramo = true
  return true
}

function actualizarDescensoClearedToLandBase(aeronave, tipoSegmentoActual, intervaloMS) {
  if (!aeronave) return

  const enBaseCleared =
    aeronave.estado === "CLEARED TO LAND" &&
    tipoSegmentoActual === "base"

  if (!enBaseCleared) {
    if (aeronave.clearedBaseDescensoActivo) {
      const altitudInicio = Number(aeronave.clearedBaseAltitudInicioFt)
      const altitudActual = Number.isFinite(aeronave.altitud) ? aeronave.altitud : 0
      if (
        Number.isFinite(altitudInicio) &&
        altitudInicio > CLEARED_TO_LAND_BASE_TARGET_FT &&
        altitudActual > CLEARED_TO_LAND_BASE_TARGET_FT
      ) {
        aeronave.altitud = CLEARED_TO_LAND_BASE_TARGET_FT
      }
    }
    limpiarDescensoClearedToLandBase(aeronave)
    return
  }

  const altitudActual = Number.isFinite(aeronave.altitud) ? aeronave.altitud : 0

  if (!aeronave.clearedBaseDescensoActivo) {
    aeronave.clearedBaseDescensoActivo = true
    aeronave.clearedBaseAltitudInicioFt = altitudActual
    const distanciaTotal = calcularDistanciaRestanteBase(aeronave)
    aeronave.clearedBaseDistanciaTotalM =
      Number.isFinite(distanciaTotal) && distanciaTotal > 0
        ? distanciaTotal
        : null
  }

  const altitudInicio = Number(aeronave.clearedBaseAltitudInicioFt)
  if (!Number.isFinite(altitudInicio) || altitudInicio <= CLEARED_TO_LAND_BASE_TARGET_FT) {
    return
  }

  const distanciaTotal = Number(aeronave.clearedBaseDistanciaTotalM)
  const distanciaRestante = calcularDistanciaRestanteBase(aeronave)

  if (
    Number.isFinite(distanciaTotal) &&
    distanciaTotal > CLEARED_TO_LAND_BASE_MIN_TOTAL_DIST_M &&
    Number.isFinite(distanciaRestante)
  ) {
    const progresoBase = Math.max(
      0,
      Math.min(1, 1 - (distanciaRestante / distanciaTotal))
    )
    const altitudInterpolada =
      altitudInicio +
      ((CLEARED_TO_LAND_BASE_TARGET_FT - altitudInicio) * progresoBase)

    aeronave.altitud = Math.max(
      CLEARED_TO_LAND_BASE_TARGET_FT,
      Math.min(altitudInicio, altitudInterpolada)
    )
    return
  }

  const descensoPorTick =
    (CLEARED_TO_LAND_BASE_DESCENT_FPM / 60) * (intervaloMS / 1000)

  if (
    Number.isFinite(descensoPorTick) &&
    descensoPorTick > 0 &&
    altitudActual > CLEARED_TO_LAND_BASE_TARGET_FT
  ) {
    aeronave.altitud = Math.max(
      CLEARED_TO_LAND_BASE_TARGET_FT,
      altitudActual - descensoPorTick
    )
  }
}



function iniciarRelojSala(nombre) {

  
  if (intervalosSalas[nombre]) return;

  intervalosSalas[nombre] = setInterval(() => {

    const hora = obtenerHoraActualSala(nombre);
    if (!hora) return;

    io.to(nombre).emit("horaSala", hora);
    actualizarLetraSalaCadaHora(nombre, hora);

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

function actualizarLetraSalaCadaHora(nombre, horaActual) {
  const reloj = relojesSalas[nombre];
  if (!reloj || reloj.pausado || !reloj.letraAsignada) return;

  const segundosActuales = convertirHoraObjetoASegundos(horaActual);
  if (!Number.isFinite(segundosActuales)) return;

  if (!Number.isFinite(reloj.ultimoSegundoLetra)) {
    reloj.ultimoSegundoLetra = segundosActuales;
    return;
  }

  let deltaSegundos = segundosActuales - reloj.ultimoSegundoLetra;
  if (deltaSegundos < 0) {
    deltaSegundos += 24 * 60 * 60;
  }
  if (deltaSegundos <= 0) return;

  reloj.ultimoSegundoLetra = segundosActuales;
  reloj.segundosAcumuladosLetra += deltaSegundos;

  const horasCumplidas = Math.floor(reloj.segundosAcumuladosLetra / 3600);
  if (horasCumplidas < 1) return;

  reloj.segundosAcumuladosLetra -= horasCumplidas * 3600;
  for (let i = 0; i < horasCumplidas; i++) {
    reloj.letraActual = generarLetraAleatoriaAZ();
  }

  io.to(nombre).emit("letraPanelSala", { letra: reloj.letraActual });
}

function iniciarMotorSala(nombreSala){

  if (motoresSalas[nombreSala]) return

  motoresSalas[nombreSala] = setInterval(() => {

    const sala = salas[nombreSala]
    if (!sala) return

	    const intervaloMS = 50
	
	    sala.aeronaves.forEach(a => {
	if (a.estado !== "CLEARED TO LAND") {
	  limpiarDescensoClearedToLandBase(a)
	}
		
			if (a.estado === "LANDING" && a.owner && !MOVIMIENTO_AUTORITATIVO_SERVIDOR) {
			  return
		}
      if (procesarGoAroundEnMotor(a, intervaloMS, nombreSala)) {
        return
      }
      actualizarAltitudCircuitoProgresiva(a, intervaloMS)
      if (a.movimiento) {
        const resultado = avanzarMovimientoHacia(a, a.movimiento, intervaloMS)
        emitirActualizacionAeronave(nombreSala, a)
        if (resultado && resultado.completado) {
          const destinoMovimiento = normalizarPuntoRuta(a.movimiento && a.movimiento.destino)
          const objetivoOrbitPendiente = normalizarObjetivoPilotageServidor(
            a.pilotageObjetivoLat,
            a.pilotageObjetivoLng
          )
          const debeAutoOrbitarTrasLiberacion = Boolean(
            !a.owner &&
            a.estado === "PILOTAGE" &&
            a.pilotageMarkerTipo === "orbit" &&
            destinoMovimiento &&
            objetivoOrbitPendiente &&
            Number.isFinite(distanciaEntre(destinoMovimiento, objetivoOrbitPendiente)) &&
            distanciaEntre(destinoMovimiento, objetivoOrbitPendiente) <= 20
          )
          const token = a.movimiento && a.movimiento.token
          a.movimiento = null
          if (debeAutoOrbitarTrasLiberacion) {
            const sentidoPendiente = normalizarSentidoOrbitTexto(a.orbitSentido)
            if (activarOrbitacionFueraCircuitoServidor(sala, a, sentidoPendiente)) {
              emitirActualizacionAeronave(nombreSala, a)
              return
            }
          }
          if (token) {
            io.to(nombreSala).emit("movimientoCompletado", {
              id: a.id,
              token
            })
          }
        }
        return
      }
      
      
      
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

  emitirActualizacionAeronave(nombreSala, a)

  return
}

		      if (
		        (MOVIMIENTO_AUTORITATIVO_SERVIDOR || !a.owner) &&
		        (a.estado === "AIRBORNE" || a.estado === "PILOTAGE") &&
		        Array.isArray(a.rutaAirborne) &&
		        a.rutaAirborne.length >= 2
		      ) {
		        if (avanzarRutaAirborneLineal(a, intervaloMS)) {
	          emitirActualizacionAeronave(nombreSala, a)
	          return
		        }
		      }

		      if ((MOVIMIENTO_AUTORITATIVO_SERVIDOR || !a.owner) && !ESTADOS_RUTA_SERVIDOR.has(a.estado)) {
		        const performanceDespegueAplicada =
		          a.estado === "AIRBORNE"
		            ? aplicarPerformanceDespegueAeronave(a, intervaloMS)
		            : false
		        const velocidadMPS = obtenerVelocidadMpsFallback(a)
		        if (velocidadMPS > 0) {
		          const distanciaTick = velocidadMPS * (intervaloMS / 1000)
		          const nuevoPunto = puntoPlano(
	            { lat: a.lat, lng: a.lng },
	            a.angulo || 0,
	            distanciaTick
	          )
	          a.lat = nuevoPunto.lat
	          a.lng = nuevoPunto.lng
	          if (performanceDespegueAplicada) {
	            registrarAvanceCarreraDespegue(a, distanciaTick)
	          }
	        }

	        emitirActualizacionAeronave(nombreSala, a)
	        return
	      }

	      if (!a.ruta || a.ruta.length < 2) return

      const velocidadMPS = obtenerVelocidadMPSParaRuta(a)
      const distanciaTick = velocidadMPS * (intervaloMS/1000)




if (a.estado === "INTERCEPTING ARC") {

  const destino =
    (Array.isArray(a.ingresoDownwindWaypoints) && a.ingresoDownwindWaypoints.length > 0)
      ? a.ingresoDownwindWaypoints[0]
      : a.puntoIntercepto;
  if (!destino) {
    a.estado = "INTERCEPTING LEG";
    reiniciarGuiadoInterceptacionCircuito(a)
    return;
  }

  const posicionActual = { lat: a.lat, lng: a.lng }
  const distancia = distanciaEntre(
    posicionActual,
    destino
  );

  const velocidadMPS = obtenerVelocidadMPSParaRuta(a);
  const distanciaTick = velocidadMPS * (intervaloMS / 1000);

  let rumboTramoObjetivo = null
  let puntoTramoObjetivo = null
  let distanciaTramoObjetivo = Infinity
  const ultimoWaypointIngreso =
    !Array.isArray(a.ingresoDownwindWaypoints) ||
    a.ingresoDownwindWaypoints.length <= 1

  if (Number.isFinite(a.tramoObjetivo)) {
    const indiceA =
      ((a.tramoObjetivo % a.ruta.length) + a.ruta.length) % a.ruta.length
    const ATramo = a.ruta[indiceA]
    const BTramo = a.ruta[(indiceA - 1 + a.ruta.length) % a.ruta.length]
    if (ATramo && BTramo) {
      const proyeccionTramo = proyectarSobreSegmentoConFactor(
        posicionActual,
        ATramo,
        BTramo
      )
      puntoTramoObjetivo = proyeccionTramo.punto
      distanciaTramoObjetivo = distanciaEntre(posicionActual, proyeccionTramo.punto)
      rumboTramoObjetivo = calcularRumboServidor(ATramo, BTramo)
    }
  }

  if (
    ultimoWaypointIngreso &&
    puntoTramoObjetivo &&
    distanciaTramoObjetivo <= INTERCEPT_ARC_DIRECT_TO_LEG_DISTANCE_M
  ) {
    a.ingresoDownwindWaypoints = null
    a.ingresoDownwindTipo = null
    a.puntoIntercepto = puntoTramoObjetivo
    a.estado = "INTERCEPTING LEG"
    reiniciarGuiadoInterceptacionCircuito(a)
    return
  }

  
  let rumboObjetivo = calcularRumboServidor(posicionActual, destino)
  if (
    ultimoWaypointIngreso &&
    Number.isFinite(rumboTramoObjetivo) &&
    Number.isFinite(distanciaTramoObjetivo)
  ) {
    const factorAlineacionTramo = Math.max(
      0,
      Math.min(
        1,
        1 - (distanciaTramoObjetivo / INTERCEPT_ARC_DIRECT_TO_LEG_DISTANCE_M)
      )
    )
    rumboObjetivo = interpolarRumbo(
      rumboObjetivo,
      rumboTramoObjetivo,
      factorAlineacionTramo * 0.7
    )
  }

  const factorCercaniaDestino = Math.max(
    0,
    Math.min(1, 1 - (distancia / 320))
  )
  const maxGiro =
    INTERCEPT_ARC_MAX_TURN_FAR_DEG +
    (INTERCEPT_ARC_MAX_TURN_NEAR_DEG - INTERCEPT_ARC_MAX_TURN_FAR_DEG) *
      factorCercaniaDestino
  const headingActual = Number.isFinite(a.angulo) ? a.angulo : rumboObjetivo
  a.angulo = aplicarVirajeLimitado(headingActual, rumboObjetivo, maxGiro)
  a.angulo = (a.angulo + 360) % 360;

  const nuevoPunto = puntoPlano(
    posicionActual,
    a.angulo,
    distanciaTick
  );

  a.lat = nuevoPunto.lat;
  a.lng = nuevoPunto.lng;

  
  if (distancia < INTERCEPT_ARC_CAPTURE_DISTANCE_M) {
    if (Array.isArray(a.ingresoDownwindWaypoints) && a.ingresoDownwindWaypoints.length > 0) {
      a.ingresoDownwindWaypoints.shift()

      if (a.ingresoDownwindWaypoints.length > 0) {
        a.puntoIntercepto = a.ingresoDownwindWaypoints[0]
      } else {
        a.ingresoDownwindWaypoints = null
        a.ingresoDownwindTipo = null
        a.puntoIntercepto = null
        a.estado = "INTERCEPTING LEG";
        reiniciarGuiadoInterceptacionCircuito(a)
      }
    } else {
      a.estado = "INTERCEPTING LEG";
      reiniciarGuiadoInterceptacionCircuito(a)
    }
  }

  emitirActualizacionAeronave(nombreSala, a);

  return;
}
      
      
      
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
    reiniciarGuiadoInterceptacionCircuito(a)
    return;
  }

  const posicionActual = { lat: a.lat, lng: a.lng }
  const distanciaSegmento = Math.max(1, distanciaEntre(A, B));
  let puntoInterceptoDirecto =
    a.puntoIntercepto &&
    Number.isFinite(Number(a.puntoIntercepto.lat)) &&
    Number.isFinite(Number(a.puntoIntercepto.lng))
      ? {
          lat: Number(a.puntoIntercepto.lat),
          lng: Number(a.puntoIntercepto.lng)
        }
      : null

  
  const proyeccion = proyectarSobreSegmentoConFactor(
    posicionActual,
    A,
    B
  );
  const puntoProyectado = proyeccion.punto;

  const distanciaAlTramo = distanciaEntre(
    posicionActual,
    puntoProyectado
  );

  if (!puntoInterceptoDirecto) {
    puntoInterceptoDirecto = {
      lat: puntoProyectado.lat,
      lng: puntoProyectado.lng
    }
    a.puntoIntercepto = puntoInterceptoDirecto
  }

  a.interceptacionDirectaTramo = true
  const distanciaPuntoIntercepto = distanciaEntre(
    posicionActual,
    puntoInterceptoDirecto
  )
  const rumboGuiado = calcularRumboServidor(posicionActual, puntoInterceptoDirecto);
  const rumboTramo = calcularRumboServidor(A, B);

  const factorCurva = Math.max(
    0,
    Math.min(1, 1 - (distanciaPuntoIntercepto / INTERCEPT_DIRECT_TO_LEG_ALIGN_DISTANCE_M))
  )
  const usarAlineacionDirecta =
    distanciaPuntoIntercepto <= INTERCEPT_DIRECT_TO_LEG_CAPTURE_DISTANCE_M ||
    distanciaAlTramo <= INTERCEPT_LEG_FINAL_ALIGN_DISTANCE_M
  const rumboObjetivoBase =
    Number.isFinite(rumboGuiado) && !usarAlineacionDirecta
      ? rumboGuiado
      : rumboTramo
  const rumboObjetivo = Number.isFinite(rumboObjetivoBase)
    ? rumboObjetivoBase
    : (Number.isFinite(a.angulo) ? a.angulo : 0)
  a.interceptHeadingRef = rumboObjetivo

  const maxGiro =
    INTERCEPT_DIRECT_TO_LEG_MAX_TURN_FAR_DEG +
    (INTERCEPT_DIRECT_TO_LEG_MAX_TURN_NEAR_DEG - INTERCEPT_DIRECT_TO_LEG_MAX_TURN_FAR_DEG) *
      factorCurva;

  const headingActual = Number.isFinite(a.angulo) ? a.angulo : rumboObjetivo;
  a.angulo = aplicarVirajeLimitado(headingActual, rumboObjetivo, maxGiro)

  a.angulo = (a.angulo + 360) % 360;

  const nuevoPunto = puntoPlano(
    posicionActual,
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

  
  const capturaPrecisa = distanciaFinalAlTramo < 18 && errorRumbo < 8;
  const capturaCercana =
    distanciaFinalAlTramo < INTERCEPT_LEG_SOFT_CAPTURE_DISTANCE_M &&
    errorRumbo < INTERCEPT_LEG_SOFT_CAPTURE_HEADING_DEG &&
    a.interceptTicks > INTERCEPT_LEG_SOFT_CAPTURE_MIN_TICKS;
  const capturaForzada =
    a.interceptTicks > INTERCEPT_LEG_FORCE_CAPTURE_TICKS &&
    distanciaFinalAlTramo < INTERCEPT_LEG_FORCE_CAPTURE_DISTANCE_M;
  const capturaRescate =
    a.interceptTicks > INTERCEPT_LEG_RESCUE_CAPTURE_TICKS &&
    distanciaFinalAlTramo < INTERCEPT_LEG_RESCUE_CAPTURE_DISTANCE_M;
  const capturaDirecta =
    distanciaPuntoIntercepto < INTERCEPT_DIRECT_TO_LEG_CAPTURE_DISTANCE_M &&
    distanciaFinalAlTramo < INTERCEPT_LEG_FORCE_CAPTURE_DISTANCE_M;

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

  if (capturaPrecisa || capturaCercana || capturaForzada || capturaRescate || capturaDirecta || capturaTimeout) {
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
    reiniciarGuiadoInterceptacionCircuito(a)
    a.tramoObjetivo = indiceCaptura;
    a.indice = indiceCaptura;
    a.progreso = progresoCaptura;
  }

  emitirActualizacionAeronave(nombreSala, a);

  return;
}
      
      
      
      if (
        a.estado !== "CIRCUIT" &&
        a.estado !== "ORBT" &&
        a.estado !== "CLEARED TO LAND"
      ) return

      if (a.orbitEnCurso) {
        const deltaAngular =
          ORBIT_TASA_VIRAJE_GRADOS_SEG *
          (intervaloMS / 1000) *
          obtenerSignoSentidoOrbit(a.orbitSentido)
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

        emitirActualizacionAeronave(nombreSala, a)

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
          obtenerSignoSentidoOrbit(a.orbitSentido)
        a.orbitEnCurso = true
        a.orbitPendiente = false
        a.orbitDetenerSolicitado = false
        a.orbitFueraCircuitoActivo = false
        a.estado = "ORBT"
        a.angulo = (rumboBase + deltaAngularEntrada + 360) % 360
        a.orbitCentro = null
        a.orbitRadio = null
        a.orbitBearing = null
        a.orbitAcumulado = 0

        emitirActualizacionAeronave(nombreSala, a)

        return
      }

      const posicionAntesMovimiento = { lat: a.lat, lng: a.lng }
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
	      const tipoSegmentoMovimiento = obtenerTipoSegmentoRuta(A, B, rumboDeseado)
	
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

      const distanciaUmbral22Antes = distanciaEntre(
        posicionAntesMovimiento,
        UMBRAL_22_COORDS
      )
      const distanciaUmbral22Despues = distanciaEntre(
        { lat: a.lat, lng: a.lng },
        UMBRAL_22_COORDS
      )
      const restablecerCircuitoEnUmbral22 =
        tieneExtensionLocalAeronave(a) &&
        (
          (tipoSegmentoActual === "final" && tipoSegmentoMovimiento === "upwind") ||
          (
            (tipoSegmentoActual === "final" || tipoSegmentoMovimiento === "upwind") &&
            distanciaUmbral22Antes > CIRCUITO_RESET_UMBRAL_22_DIST_M &&
            distanciaUmbral22Despues <= CIRCUITO_RESET_UMBRAL_22_DIST_M
          )
        )

      if (restablecerCircuitoEnUmbral22) {
        restablecerCircuitoOriginalAlCruzarUmbral22(nombreSala, sala, a)
      }

	      actualizarDescensoClearedToLandBase(a, tipoSegmentoMovimiento, intervaloMS)
	
      emitirActualizacionAeronave(nombreSala, a)

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

function generarRutaServidor(sala, opciones = {}){

  const umbral04 = UMBRAL_04_COORDS
  const umbral22 = UMBRAL_22_COORDS

  const rumboPista = calcularRumboServidor(umbral04, umbral22)
  const rumboInverso = calcularRumboServidor(umbral22, umbral04)
  const sentidoCircuito = normalizarSentidoCircuitoTexto(opciones?.sentidoCircuito)
  const circuitoDerecha = sentidoCircuito === "RIGHT"
  const rumboLateral = circuitoDerecha
    ? (rumboInverso + 90) % 360
    : (rumboInverso - 90 + 360) % 360

  const factorShortCircuitoRaw =
    typeof opciones?.shortFactor === "number" ? opciones.shortFactor : 1
  const factorShortCircuito =
    Number.isFinite(factorShortCircuitoRaw) && factorShortCircuitoRaw > 0
      ? factorShortCircuitoRaw
      : 1
  const usarBaseRecta = Boolean(opciones?.baseRecta)

  const separacionFinalDownwindM = 1.5 * 1852

  const longitudFinalBaseM = CIRCUITO_LONGITUD_FINAL_BASE_M
  const longitudUpwindBaseM = CIRCUITO_LONGITUD_UPWIND_BASE_M
  const extensionGeneral = sala.extensionExtra || 0
  const extensionDownwindExtra =
    typeof sala.extensionDownwindExtra === "number"
      ? sala.extensionDownwindExtra
      : extensionGeneral
  const extensionUpwindExtra =
    typeof sala.extensionUpwindExtra === "number"
      ? sala.extensionUpwindExtra
      : extensionGeneral

  const longitudFinalMBase = longitudFinalBaseM + extensionDownwindExtra
  const longitudFinalM = longitudFinalMBase * factorShortCircuito
  const longitudUpwindM = longitudUpwindBaseM + extensionUpwindExtra

  
  const separacionPiernasM = separacionFinalDownwindM
  const rumboCentrolinea = rumboInverso
  const rumboCrosswind = rumboLateral
  const rumboCrosswindInverso = (rumboCrosswind + 180) % 360
  const rumboDownwind = rumboPista
  const rumboBase = rumboCrosswindInverso

  const factorRadioEsquina = usarBaseRecta ? 0.78 : 1
  const radioEsquinaM = Math.max(
    120,
    Math.min(
      0.25 * 1852 * factorRadioEsquina,
      Math.max(160, (separacionPiernasM / 2) - 60),
      Math.max(150, longitudFinalM * 0.45),
      Math.max(180, longitudUpwindM * 0.32)
    )
  )

  const finalExt = puntoPlano(umbral22, rumboPista, longitudFinalM + radioEsquinaM)
  const salidaExt = puntoPlano(umbral04, rumboInverso, longitudUpwindM + radioEsquinaM)
  const salidaExtLateral = puntoPlano(salidaExt, rumboLateral, separacionPiernasM)
  const finalExtLateral = puntoPlano(finalExt, rumboLateral, separacionPiernasM)

  const distanciaRectaM = distanciaEntre(finalExt, salidaExt)
  const longitudCurvaM = (Math.PI * radioEsquinaM) / 2
  const separacionObjetivoM = 70

  const pasosRecta = Math.max(20, Math.round(distanciaRectaM / separacionObjetivoM))
  const pasosCurva = Math.max(
    10,
    Math.round(longitudCurvaM / separacionObjetivoM)
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
    tipoTramo = "upwind",
    incluirFin = true
  ) {
    const distancia = distanciaEntre(A, B)
    const rumbo = calcularRumboServidor(A, B)
    const inicio = incluirInicio ? 0 : 1
    const limite = incluirFin ? pasos : (pasos - 1)
    if (limite < inicio) return

    for (let i = inicio; i <= limite; i++) {
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

  function agregarCurvaSuave(
    inicioTangente,
    vertice,
    finTangente,
    pasos,
    tipoTramo,
    incluirFin = true
  ) {
    const limite = incluirFin ? pasos : (pasos - 1)
    for (let i = 1; i <= limite; i++) {
      const t = i / pasos
      const invT = 1 - t
      const punto = {
        lat:
          (invT * invT * inicioTangente.lat) +
          (2 * invT * t * vertice.lat) +
          (t * t * finTangente.lat),
        lng:
          (invT * invT * inicioTangente.lng) +
          (2 * invT * t * vertice.lng) +
          (t * t * finTangente.lng)
      }
      registrarPunto(punto, tipoTramo)
    }
  }

  const inicioCentrolinea = puntoPlano(finalExt, rumboCentrolinea, radioEsquinaM)
  const finCentrolinea = puntoPlano(salidaExt, rumboPista, radioEsquinaM)
  const inicioCrosswind = puntoPlano(salidaExt, rumboCrosswind, radioEsquinaM)
  const finCrosswind = puntoPlano(salidaExtLateral, rumboCrosswindInverso, radioEsquinaM)
  const inicioDownwind = puntoPlano(salidaExtLateral, rumboDownwind, radioEsquinaM)
  const finDownwind = puntoPlano(finalExtLateral, rumboInverso, radioEsquinaM)
  const inicioBase = puntoPlano(finalExtLateral, rumboBase, radioEsquinaM)
  const finBase = puntoPlano(finalExt, rumboLateral, radioEsquinaM)
  const distanciaCrosswindM = distanciaEntre(inicioCrosswind, finCrosswind)
  const distanciaBaseM = distanciaEntre(inicioBase, finBase)
  const pasosCrosswind = Math.max(8, Math.round(distanciaCrosswindM / separacionObjetivoM))
  const pasosBase = Math.max(8, Math.round(distanciaBaseM / separacionObjetivoM))

  
  agregarRecta(
    inicioCentrolinea,
    finCentrolinea,
    pasosRecta,
    true,
    ({ distanciaRecorrida }) =>
      distanciaRecorrida <= longitudFinalM ? "final" : "upwind"
  )

  
  agregarCurvaSuave(
    finCentrolinea,
    salidaExt,
    inicioCrosswind,
    pasosCurva,
    "crosswind",
    true
  )
  agregarRecta(inicioCrosswind, finCrosswind, pasosCrosswind, false, "crosswind")
  agregarCurvaSuave(
    finCrosswind,
    salidaExtLateral,
    inicioDownwind,
    pasosCurva,
    "crosswind",
    true
  )

  
  agregarRecta(inicioDownwind, finDownwind, pasosRecta, false, "downwind")

  
  agregarCurvaSuave(
    finDownwind,
    finalExtLateral,
    inicioBase,
    pasosCurva,
    "base",
    true
  )
  agregarRecta(inicioBase, finBase, pasosBase, false, "base", true)
  agregarCurvaSuave(
    finBase,
    finalExt,
    inicioCentrolinea,
    pasosCurva,
    "base",
    false
  )

  if (puntos.length > 1) {
    
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
  if (aeronave.shortCircuitoActivo) return true

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

function requiereRutaPropiaAeronave(aeronave) {
  return tieneExtensionLocalAeronave(aeronave) || esCircuitoDerecha(aeronave)
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

  const shortActivo = Boolean(aeronave && aeronave.shortCircuitoActivo)
  const extensionDownwindExtra = base.downwind + extraDownwindAeronave
  const factorShortCircuito = shortActivo ? SHORT_CIRCUITO_FACTOR : 1

  return generarRutaServidor(
    {
      ...sala,
      extensionUpwindExtra: base.upwind + extraUpwindAeronave,
      extensionDownwindExtra
    },
    {
      shortFactor: factorShortCircuito,
      baseRecta: shortActivo,
      sentidoCircuito: normalizarSentidoCircuitoTexto(aeronave?.circuitoSentido)
    }
  )
}

function clasificarTramoPorRumbo(rumbo, sentidoCircuito = null) {
  const rumbosCircuito = obtenerRumbosCircuito(sentidoCircuito)
  const candidatos = [
    { tipo: "upwind", rumbo: rumbosCircuito.upwind },
    { tipo: "downwind", rumbo: rumbosCircuito.downwind },
    { tipo: "crosswind", rumbo: rumbosCircuito.crosswind },
    { tipo: "base", rumbo: rumbosCircuito.base }
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

function obtenerTipoSegmentoRuta(A, B, rumboSegmento = null, sentidoCircuito = null) {
  if (A && typeof A.tramo === "string" && A.tramo.length > 0) {
    return A.tramo
  }

  const rumbo =
    typeof rumboSegmento === "number"
      ? rumboSegmento
      : calcularRumboServidor(A, B)

  return clasificarTramoPorRumbo(rumbo, sentidoCircuito)
}

function obtenerTramoActualAeronave(aeronave) {
  if (!aeronave || !aeronave.ruta || aeronave.ruta.length < 2) {
    return {
      tipo: clasificarTramoPorRumbo(aeronave?.angulo || 0, aeronave),
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
  const tipo = obtenerTipoSegmentoRuta(A, B, rumbo, aeronave)

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
  const sentidoCircuito = normalizarSentidoCircuitoTexto(aeronave.circuitoSentido)
  const ladoInterior = sentidoCircuito === "RIGHT" ? "EAST" : "WEST"

  const waypoints = []

  if (ladoIngreso === "SOUTH") {
    waypoints.push(joinPoint)
  } else {
    const rumboIngreso45 =
      sentidoCircuito === "RIGHT"
        ? (rumboDownwind + INGRESO_DOWNWIND_ANGULO_GRADOS) % 360
        : (rumboDownwind - INGRESO_DOWNWIND_ANGULO_GRADOS + 360) % 360
    const preEntryPoint = puntoPlano(
      joinPoint,
      (rumboIngreso45 + 180) % 360,
      INGRESO_DOWNWIND_PREENTRY_M
    )

    if (ladoIngreso === ladoInterior) {
      const rumboCruceExterior =
        sentidoCircuito === "RIGHT"
          ? (rumboDownwind + 270) % 360
          : (rumboDownwind + 90) % 360
      
      const puntoCruce = puntoPlano(
        joinPoint,
        rumboCruceExterior,
        INGRESO_DOWNWIND_CRUCE_M
      )
      const puntoGota = puntoPlano(
        puntoCruce,
        (rumboDownwind + 180) % 360,
        INGRESO_DOWNWIND_GOTA_M
      )
      waypoints.push(puntoCruce, puntoGota)
    }

    
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
          ladoIngreso === ladoInterior
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
    const rutaAeronave = requiereRutaPropiaAeronave(a)
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

function puedeActivarGoAroundEnFinal(sala, aeronave) {
  if (!sala || !aeronave) return false

  const rumboActual = Number(aeronave.angulo)
  if (Number.isFinite(rumboActual)) {
    const errorRumbo = Math.abs(
      diferenciaAngular(rumboActual, GO_AROUND_TRIGGER_HEADING)
    )
    if (errorRumbo > GO_AROUND_FINAL_HEADING_ACTIVACION_TOL) {
      return false
    }
  }

  let rutaReferencia = aeronave.ruta
  if (!rutaReferencia || rutaReferencia.length < 2) {
    rutaReferencia = generarRutaServidorParaAeronave(sala, aeronave)
  }
  if (!rutaReferencia || rutaReferencia.length < 2) {
    return false
  }

  const proyeccionFinal = obtenerProyeccionRutaMasCercana(
    { lat: aeronave.lat, lng: aeronave.lng },
    rutaReferencia,
    "final"
  )

  return Boolean(
    proyeccionFinal &&
      Number.isFinite(proyeccionFinal.distancia) &&
      proyeccionFinal.distancia <= GO_AROUND_FINAL_MAX_DIST_M
  )
}

function emitirActualizacionAeronave(nombreSala, aeronave, extras = {}) {
  io.to(nombreSala).emit(
    "actualizarAeronave",
    construirPayloadActualizacionAeronave(aeronave, extras)
  )
}

function prepararAeronaveParaCircuito(salaNombre, sala, aeronave, opciones = {}) {
  if (!salaNombre || !sala || !aeronave) return false

  limpiarOrbitacionAeronave(aeronave)
  aeronave.altitudCircuitoAutomaticaActiva = true
  aeronave.circuitoSentido = normalizarSentidoCircuitoTexto(
    opciones && opciones.sentidoCircuito !== undefined
      ? opciones.sentidoCircuito
      : aeronave.circuitoSentido
  )
  aeronave.rutaAirborne = null
  aeronave.rutaAirborneFinalizada = false
  aeronave.rutaAirborneIndice = 0
  aeronave.rutaAirborneProgreso = 0
  aeronave.rutaAirborneLoop = false
  aeronave.rutaAirborneLoopStartIndex = 0
  aeronave.arrivalProcedureName = null
  aeronave.arrivalAltitudeProfile = null
  aeronave.arrivalHoldingMumopManualAltitudeFt = null
  aeronave.fase = null
  aeronave.takeoffRollProgressM = 0

  aeronave.ruta = generarRutaServidorParaAeronave(sala, aeronave)

  io.to(salaNombre).emit("rutaCircuito", {
    id: aeronave.id,
    ruta: aeronave.ruta,
    sentidoCircuito: normalizarSentidoCircuitoTexto(aeronave.circuitoSentido)
  })

  const modoIngresoRaw =
    opciones && typeof opciones.modoIngreso === "string"
      ? opciones.modoIngreso.trim().toLowerCase()
      : ""
  const mapaIngresoPorTramo = {
    upwind: "upwind",
    upw: "upwind",
    uw: "upwind",
    crosswind: "crosswind",
    cw: "crosswind",
    downwind: "downwind",
    dw: "downwind",
    base: "base",
    bs: "base",
    final: "final",
    fnl: "final"
  }
  const tipoObjetivo = mapaIngresoPorTramo[modoIngresoRaw] || null
  const posicionActual = { lat: aeronave.lat, lng: aeronave.lng }

  if (tipoObjetivo) {
    const proyeccionTramo = obtenerProyeccionRutaMasCercana(
      posicionActual,
      aeronave.ruta,
      tipoObjetivo
    )
    if (proyeccionTramo) {
      aeronave.tramoObjetivo = proyeccionTramo.indiceA
      aeronave.puntoIntercepto = proyeccionTramo.puntoIntercepto
      aeronave.ingresoDownwindWaypoints = null
      aeronave.ingresoDownwindTipo = null
      aeronave.estado = "INTERCEPTING ARC"
      reiniciarGuiadoInterceptacionCircuito(aeronave)
      aeronave.velocidad = GO_AROUND_SPEED_DEFAULT_KT * 0.514444
      aeronave.velocidadObjetivo = GO_AROUND_SPEED_DEFAULT_KT

      iniciarMotorSala(salaNombre)
      return true
    }
  }

  let usarIngresoMasCercano = opciones && opciones.modoIngreso === "nearest"
  if (!usarIngresoMasCercano && opciones && opciones.modoIngreso === "nearest-if-close") {
    const proyeccionCercana = obtenerProyeccionRutaMasCercana(
      posicionActual,
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
    reiniciarGuiadoInterceptacionCircuito(aeronave)
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
  reiniciarGuiadoInterceptacionCircuito(aeronave)
  aeronave.velocidad = GO_AROUND_SPEED_DEFAULT_KT * 0.514444
  aeronave.velocidadObjetivo = GO_AROUND_SPEED_DEFAULT_KT

  iniciarMotorSala(salaNombre)
  return true
}

function procesarGoAroundEnMotor(aeronave, intervaloMS, nombreSala) {
  if (!aeronave || !aeronave.goAroundActivo) return false
  if (aeronave.movimiento) {
    aeronave.movimiento = null
  }

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

  const velocidadBaseKt =
    (Number.isFinite(aeronave.velocidadObjetivo) && aeronave.velocidadObjetivo > 0)
      ? aeronave.velocidadObjetivo
      : GO_AROUND_SPEED_DEFAULT_KT
  const incrementoVelocidadKt =
    GO_AROUND_ACCEL_KT_POR_SEG * (intervaloMS / 1000)
  const velocidadObjetivoKt = Math.min(
    GO_AROUND_SPEED_TARGET_KT,
    Math.max(GO_AROUND_SPEED_DEFAULT_KT, velocidadBaseKt) + incrementoVelocidadKt
  )
  const velocidadMPS = velocidadObjetivoKt * 0.514444
  const distanciaTick = velocidadMPS * (intervaloMS / 1000)

  let headingObjetivo = GO_AROUND_TRIGGER_HEADING
  const radialActual = calcularRumboServidor(
    SCO_VOR_COORDS,
    { lat: aeronave.lat, lng: aeronave.lng }
  )
  const radialObjetivoVerdadero =
    convertirRadialScoMagneticoAVerdadero(GO_AROUND_RADIAL_OBJETIVO)

  if (aeronave.goAroundFase === "TO_RADIAL") {
    const errorRadial = diferenciaAngular(radialActual, radialObjetivoVerdadero)
    if (Math.abs(errorRadial) <= GO_AROUND_INTERCEPT_TOL) {
      aeronave.goAroundFase = "ON_RADIAL"
    }
  }

  if (aeronave.goAroundFase === "ON_RADIAL") {
    const errorRadial = diferenciaAngular(radialActual, radialObjetivoVerdadero)
    const correccion = Math.max(-12, Math.min(12, errorRadial * 1.5))
    headingObjetivo = (radialObjetivoVerdadero + correccion + 360) % 360

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






io.on("connection", (socket) => {

  console.log("Nuevo usuario:", socket.id);

  modosOperacionPorSocket.set(socket.id, "controlador")

  socket.emit("listaSalas", obtenerListaSalas());

  const normalizarEstadoRescate = (data = {}, base = {}) => {
    const estado = { ...base };
    if (typeof data.id === "string" && data.id.trim()) {
      estado.id = data.id.trim();
    }
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (Number.isFinite(lat)) {
      estado.lat = lat;
    }
    if (Number.isFinite(lng)) {
      estado.lng = lng;
    }
    const angulo = Number(data.angulo);
    if (Number.isFinite(angulo)) {
      estado.angulo = angulo;
    }
    const velocidad = Number(data.velocidad);
    if (Number.isFinite(velocidad)) {
      estado.velocidad = velocidad;
    }
    const velocidadObjetivo = Number(data.velocidadObjetivo);
    if (Number.isFinite(velocidadObjetivo)) {
      estado.velocidadObjetivo = velocidadObjetivo;
    }
    if (typeof data.estado === "string") {
      estado.estado = data.estado;
    }
    return estado;
  };

  const crearEstadoServiciosControlador = (base = {}) => ({
    lights: {
      rwy: Boolean(base?.lights?.rwy),
      twy: Boolean(base?.lights?.twy),
      apron: Boolean(base?.lights?.apron),
      papi: Boolean(base?.lights?.papi)
    },
    emergency: {
      flash: Boolean(base?.emergency?.flash),
      green: Boolean(base?.emergency?.green),
      red: Boolean(base?.emergency?.red),
      white: Boolean(base?.emergency?.white)
    },
    pyrotechnic: {
      startTs: Number.isFinite(Number(base?.pyrotechnic?.startTs))
        ? Number(base.pyrotechnic.startTs)
        : null
    }
  });

  const normalizarEstadoServiciosControlador = (data = {}, base = {}) => {
    const estado = crearEstadoServiciosControlador(base);
    const lights = data && typeof data.lights === "object" ? data.lights : {};
    const emergency = data && typeof data.emergency === "object" ? data.emergency : {};
    const pyrotechnic = data && typeof data.pyrotechnic === "object" ? data.pyrotechnic : {};

    ["rwy", "twy", "apron", "papi"].forEach((clave) => {
      if (Object.prototype.hasOwnProperty.call(lights, clave)) {
        estado.lights[clave] = Boolean(lights[clave]);
      }
    });

    ["flash", "green", "red", "white"].forEach((clave) => {
      if (Object.prototype.hasOwnProperty.call(emergency, clave)) {
        estado.emergency[clave] = Boolean(emergency[clave]);
      }
    });

    if (Object.prototype.hasOwnProperty.call(pyrotechnic, "startTs")) {
      const startTs = Number(pyrotechnic.startTs);
      estado.pyrotechnic.startTs =
        Number.isFinite(startTs) && (Date.now() - startTs) < PYROTECHNIC_LIGHT_DURATION_MS
          ? startTs
          : null;
    }

    const startActual = Number(estado.pyrotechnic.startTs);
    if (!Number.isFinite(startActual) || (Date.now() - startActual) >= PYROTECHNIC_LIGHT_DURATION_MS) {
      estado.pyrotechnic.startTs = null;
    }

    return estado;
  };

  
  socket.on("crearSala", ({ nombre, horaInicial }) => {

    if (salas[nombre]) return;

    const segundosIniciales = horaInicial
      ? convertirHoraASegundos(horaInicial)
      : 0;

    salas[nombre] = {
      jugadores: [],
      aeronaves: [],
      rescate: null,
      serviciosControlador: crearEstadoServiciosControlador(),
      extensionExtra: 0,
      extensionUpwindExtra: 0,
      extensionDownwindExtra: 0
    };

relojesSalas[nombre] = {
  tiempoBase: segundosIniciales,
  timestampBase: Date.now(),
  velocidad: 1,
  pausado: true,
  panelHoraInicio: null,
  letraActual: "--",
  letraAsignada: false,
  segundosAcumuladosLetra: 0,
  ultimoSegundoLetra: null
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
  reloj.letraActual = generarLetraAleatoriaAZ();
  reloj.letraAsignada = true;
  reloj.segundosAcumuladosLetra = 0;
  reloj.ultimoSegundoLetra = ((segundos % 86400) + 86400) % 86400;

  io.to(sala).emit("horaSala", formatearHora(segundos));
  io.to(sala).emit("letraPanelSala", { letra: reloj.letraActual });
});

  
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
    salas[nombre].aeronaves.forEach(a => {
      if(a){
        a.owner = null
      }
    })
    socket.emit("cargarAeronaves", salas[nombre].aeronaves);
    if(salas[nombre].rescate){
      socket.emit("actualizarRescate", salas[nombre].rescate);
    }
    salas[nombre].serviciosControlador = normalizarEstadoServiciosControlador(
      salas[nombre].serviciosControlador,
      salas[nombre].serviciosControlador
    );
    socket.emit("actualizarServiciosControlador", salas[nombre].serviciosControlador);
if (peligroSalas[nombre]) {
  socket.emit("peligroActivado");
}

    socket.emit("rutaCircuito", {
      ruta: generarRutaServidor(salas[nombre])
    });

    
    const horaActual = obtenerHoraActualSala(nombre);
    if (horaActual) {
      socket.emit("horaSala", horaActual);
    }
    socket.emit("estadoTiempo", {
      pausado: relojesSalas[nombre].pausado,
      panelHora: relojesSalas[nombre].panelHoraInicio || null
    });
    socket.emit("letraPanelSala", {
      letra: relojesSalas[nombre].letraActual || "--"
    });

    io.emit("listaSalas", obtenerListaSalas());
  });

  socket.on("registrarRescate", (data = {}) => {
    const salaNombre = socket.sala;
    if (!salaNombre || !salas[salaNombre]) return;
    if (salas[salaNombre].rescate) return;

    const estado = normalizarEstadoRescate(data, {});
    if (!Number.isFinite(estado.lat) || !Number.isFinite(estado.lng)) return;

    salas[salaNombre].rescate = estado;
    io.to(salaNombre).emit("actualizarRescate", estado);
  });

  socket.on("actualizarRescate", (data = {}) => {
    const salaNombre = socket.sala;
    if (!salaNombre || !salas[salaNombre]) return;

    const base = salas[salaNombre].rescate || {};
    const estado = normalizarEstadoRescate(data, base);
    if (!Number.isFinite(estado.lat) || !Number.isFinite(estado.lng)) return;

    salas[salaNombre].rescate = estado;
    socket.to(salaNombre).emit("actualizarRescate", estado);
  });

  socket.on("actualizarServiciosControlador", (data = {}) => {
    const salaNombre = socket.sala;
    if (!salaNombre || !salas[salaNombre]) return;

    const base = salas[salaNombre].serviciosControlador || crearEstadoServiciosControlador();
    const estado = normalizarEstadoServiciosControlador(data, base);
    salas[salaNombre].serviciosControlador = estado;
    io.to(salaNombre).emit("actualizarServiciosControlador", estado);
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
    pausado: reloj.pausado,
    panelHora: reloj.panelHoraInicio || null
  })
  socket.emit("letraPanelSala", {
    letra: reloj.letraActual || "--"
  })
})

  
  socket.on("crearAeronave", (data) => {

  const sala = socket.sala;
  if (!sala) return;

  const nuevaAeronave = crearRegistroAeronave(data)
  salas[sala].aeronaves.push(nuevaAeronave)


  io.to(sala).emit("crearAeronave", {
    tipo: nuevaAeronave.tipo,
    owner: nuevaAeronave.owner,
    orbitPendiente: nuevaAeronave.orbitPendiente,
    orbitEnCurso: nuevaAeronave.orbitEnCurso,
    orbitModoContinuo: nuevaAeronave.orbitModoContinuo,
    orbitDetenerSolicitado: nuevaAeronave.orbitDetenerSolicitado,
    ...construirPayloadActualizacionAeronave(nuevaAeronave)
  });
});

  socket.on("setModoOperacion", ({ modo } = {}) => {
    const modoNormalizado = typeof modo === "string" ? modo.trim() : ""
    if(modoNormalizado === "piloto" || modoNormalizado === "controlador"){
      modosOperacionPorSocket.set(socket.id, modoNormalizado)
    }
  })


socket.on("setRutaAirborne", ({ id, ruta, estado, loop, loopStartIndex, arrivalProcedureName } = {}) => {
  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a && a.id === id)
  if (!aeronave) return

  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

  const estadoNormalizado =
    typeof estado === "string"
      ? estado.trim().toUpperCase()
      : ""
  const rutaNormalizada = normalizarRutaLineal(ruta)
  const loopActivoSolicitado = Boolean(loop)
  const arrivalProcedureNormalizado =
    normalizarNombreProcedimientoLlegadaServidor(arrivalProcedureName)

  if (estadoNormalizado === "PILOTAGE" || estadoNormalizado === "AIRBORNE") {
    aeronave.estado = estadoNormalizado
    aeronave.movimiento = null
    limpiarOrbitacionAeronave(aeronave)
    reiniciarGuiadoInterceptacionCircuito(aeronave)
    aeronave.ruta = null
    aeronave.indice = 0
    aeronave.progreso = 0
    aeronave.indiceObjetivo = null
    aeronave.tramoObjetivo = null
    aeronave.puntoIntercepto = null
    aeronave.ingresoDownwindWaypoints = null
    aeronave.ingresoDownwindTipo = null
  }

  if (rutaNormalizada.length < 2) {
    if(estadoNormalizado){
      aeronave.estado = estadoNormalizado
    }
    aeronave.rutaAirborne = null
    aeronave.rutaAirborneFinalizada = false
    aeronave.rutaAirborneIndice = 0
    aeronave.rutaAirborneProgreso = 0
    aeronave.rutaAirborneLoop = false
    aeronave.rutaAirborneLoopStartIndex = 0
    aeronave.arrivalProcedureName = null
    aeronave.arrivalAltitudeProfile = null
    aeronave.arrivalHoldingMumopManualAltitudeFt = null
    iniciarMotorSala(salaNombre)
    io.to(salaNombre).emit(
      "actualizarAeronave",
      construirPayloadActualizacionAeronave(aeronave)
    )
    return
  }

  aeronave.rutaAirborne = rutaNormalizada
  aeronave.rutaAirborneFinalizada = false
  aeronave.rutaAirborneLoop = loopActivoSolicitado
  aeronave.rutaAirborneLoopStartIndex =
    loopActivoSolicitado
      ? Math.max(
          0,
          Math.min(
            rutaNormalizada.length - 2,
            normalizarIndiceLoopRutaAirborneServidor(loopStartIndex)
          )
        )
      : 0
  aeronave.arrivalProcedureName = arrivalProcedureNormalizado
  aeronave.arrivalAltitudeProfile = null
  aeronave.arrivalHoldingMumopManualAltitudeFt = null
  if(estadoNormalizado === "PILOTAGE"){
    const altitudActualFt = Number(aeronave.altitud)
    const altitudObjetivoActualFt = Number(aeronave.altitudObjetivo)
    if(Number.isFinite(altitudActualFt) && altitudActualFt > 0){
      aeronave.altitudObjetivo =
        Number.isFinite(altitudObjetivoActualFt) && altitudObjetivoActualFt > altitudActualFt
          ? altitudObjetivoActualFt
          : altitudActualFt
    }
  }

  const posicionActual = { lat: aeronave.lat, lng: aeronave.lng }
  const proyeccion = obtenerProyeccionRutaLinealMasCercana(posicionActual, rutaNormalizada)
  if (proyeccion) {
    aeronave.rutaAirborneIndice = proyeccion.indiceA
    aeronave.rutaAirborneProgreso = proyeccion.progreso
  } else {
    aeronave.rutaAirborneIndice = 0
    aeronave.rutaAirborneProgreso = 0
  }

  aeronave.arrivalAltitudeProfile = construirPerfilAltitudLlegadaServidor(aeronave)
  aplicarPerfilAltitudLlegadaServidor(aeronave)

  iniciarMotorSala(salaNombre)
  io.to(salaNombre).emit(
    "actualizarAeronave",
    construirPayloadActualizacionAeronave(aeronave)
  )
});
socket.on("iniciarMovimiento", ({ id, destino, opciones, token } = {}) => {
  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a && a.id === id)
  if (!aeronave) return

  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

  const destinoNormalizado = normalizarPuntoRuta(destino)
  if (!destinoNormalizado) return

  aeronave.movimiento = {
    destino: destinoNormalizado,
    opciones: opciones && typeof opciones === "object" ? opciones : {},
    token: typeof token === "string" ? token : null
  }

  iniciarMotorSala(salaNombre)
})
socket.on("extenderSalida", ({ metros }) => {

  const nombreSala = socket.sala
  if (!nombreSala) return

  const sala = salas[nombreSala]
  if (!sala) return

  const metrosSeguros =
    typeof metros === "number" && Number.isFinite(metros) && metros > 0
      ? metros
      : (0.5 * 1852)

  
  sala.extensionExtra += metrosSeguros
  sala.extensionUpwindExtra = (sala.extensionUpwindExtra || 0) + metrosSeguros
  sala.extensionDownwindExtra = (sala.extensionDownwindExtra || 0) + metrosSeguros

  
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
  if (!socketPuedeControlarAeronave(nombreSala, sala, aeronave, socket.id)) return

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
    if (!redirigirAeronaveAlCircuitoMasCercano(aeronave, rutaActualizada)) {
      aeronave.ruta = rutaActualizada
      reajustarAeronaveEnRuta(aeronave, rutaActualizada)
    }
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
      reiniciarGuiadoInterceptacionCircuito(aeronave)
    }

    aeronave.angulo = rumboObjetivo
  } else {
    aeronave.ruta = rutaActualizada
  }

  socket.emit("rutaCircuitoActualizada", {
    id: aeronave.id,
    ruta: rutaActualizada,
    tramoExtendido: tramoObjetivo,
    sentidoCircuito: normalizarSentidoCircuitoTexto(aeronave.circuitoSentido),
    extensionAeronave: {
      upwind: aeronave.extensionUpwindExtraLocal || 0,
      downwind: aeronave.extensionDownwindExtraLocal || 0
    }
  })
})

socket.on("acortarTramoCircuito", ({ id, metros }) => {

  const nombreSala = socket.sala
  if (!nombreSala) return

  const sala = salas[nombreSala]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (!socketPuedeControlarAeronave(nombreSala, sala, aeronave, socket.id)) return

  const metrosSeguros =
    typeof metros === "number" && Number.isFinite(metros) && metros > 0
      ? metros
      : SHORT_CIRCUITO_PASO_M

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

  if (circuitoTieneDimensionesOriginales(sala, aeronave)) {
    tramoObjetivo = "downwind"
    aeronave.extensionDownwindExtraLocal =
      -(CIRCUITO_LONGITUD_FINAL_BASE_M - CIRCUITO_LONGITUD_FINAL_SHORT_M)
  } else if (tramoObjetivo === "downwind") {
    const actual = aeronave.extensionDownwindExtraLocal || 0
    const minimoExtra = actual > 0 ? 0 : -SHORT_CIRCUITO_PASO_M
    aeronave.extensionDownwindExtraLocal = Math.max(
      minimoExtra,
      actual - metrosSeguros
    )
  } else {
    const actual = aeronave.extensionUpwindExtraLocal || 0
    const minimoExtra = actual > 0 ? 0 : -SHORT_CIRCUITO_PASO_M
    aeronave.extensionUpwindExtraLocal = Math.max(
      minimoExtra,
      actual - metrosSeguros
    )
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
    if (!redirigirAeronaveAlCircuitoMasCercano(aeronave, rutaActualizada)) {
      aeronave.ruta = rutaActualizada
      reajustarAeronaveEnRuta(aeronave, rutaActualizada)
    }
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
      reiniciarGuiadoInterceptacionCircuito(aeronave)
    }

    aeronave.angulo = rumboObjetivo
  } else {
    aeronave.ruta = rutaActualizada
  }

  socket.emit("rutaCircuitoActualizada", {
    id: aeronave.id,
    ruta: rutaActualizada,
    tramoReducido: tramoObjetivo,
    sentidoCircuito: normalizarSentidoCircuitoTexto(aeronave.circuitoSentido),
    extensionAeronave: {
      upwind: aeronave.extensionUpwindExtraLocal || 0,
      downwind: aeronave.extensionDownwindExtraLocal || 0
    }
  })
})

socket.on("shortCircuito", ({ id, activo } = {}) => {

  const nombreSala = socket.sala
  if (!nombreSala) return

  const sala = salas[nombreSala]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (!socketPuedeControlarAeronave(nombreSala, sala, aeronave, socket.id)) return

  aeronave.shortCircuitoActivo = Boolean(activo)

  const rutaActualizada = generarRutaServidorParaAeronave(sala, aeronave)
  if (aeronave.estado === "CIRCUIT") {
    reajustarAeronaveEnRuta(aeronave, rutaActualizada)
  } else if (
    (aeronave.estado === "INTERCEPTING ARC" || aeronave.estado === "INTERCEPTING LEG") &&
    aeronave.ruta
  ) {
    aeronave.ingresoDownwindWaypoints = null
    aeronave.ingresoDownwindTipo = null
    aeronave.ruta = rutaActualizada

    const proyeccionTramo = obtenerProyeccionRutaMasCercana(
      { lat: aeronave.lat, lng: aeronave.lng },
      rutaActualizada
    )
    if (proyeccionTramo) {
      aeronave.tramoObjetivo = proyeccionTramo.indiceA
      aeronave.puntoIntercepto = proyeccionTramo.puntoIntercepto
      aeronave.estado = "INTERCEPTING LEG"
      reiniciarGuiadoInterceptacionCircuito(aeronave)
    }
  } else {
    aeronave.ruta = rutaActualizada
  }

  socket.emit("rutaCircuitoActualizada", {
    id: aeronave.id,
    ruta: rutaActualizada,
    shortCircuitoActivo: Boolean(aeronave.shortCircuitoActivo),
    sentidoCircuito: normalizarSentidoCircuitoTexto(aeronave.circuitoSentido)
  })
  emitirActualizacionAeronave(nombreSala, aeronave)
})

socket.on("configurarSentidoCircuito", ({ id, sentido } = {}) => {

  const nombreSala = socket.sala
  if (!nombreSala) return

  const sala = salas[nombreSala]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (!socketPuedeControlarAeronave(nombreSala, sala, aeronave, socket.id)) return

  const tramoActualAntesCambio =
    aeronave.estado === "CIRCUIT"
      ? obtenerTramoActualAeronave(aeronave)
      : null
  const sentidoNormalizado = normalizarSentidoCircuitoTexto(sentido)
  const sentidoAnterior = normalizarSentidoCircuitoTexto(aeronave.circuitoSentido)
  if (sentidoNormalizado === sentidoAnterior) {
    emitirActualizacionAeronave(nombreSala, aeronave)
    return
  }

  aeronave.circuitoSentido = sentidoNormalizado

  const rutaActualizada = generarRutaServidorParaAeronave(sala, aeronave)

  if (aeronave.estado === "CIRCUIT") {
    const rumboReferencia =
      typeof aeronave.angulo === "number"
        ? aeronave.angulo
        : (
          Number.isFinite(tramoActualAntesCambio?.rumbo)
            ? tramoActualAntesCambio.rumbo
            : 0
        )
    const tipoObjetivo =
      ["upwind", "crosswind", "downwind", "base"].includes(tramoActualAntesCambio?.tipo)
        ? tramoActualAntesCambio.tipo
        : clasificarTramoPorRumbo(
            rumboReferencia,
            { circuitoSentido: sentidoNormalizado }
          )

    const proyeccionTramo = obtenerProyeccionRutaMasCercana(
      { lat: aeronave.lat, lng: aeronave.lng },
      rutaActualizada,
      ["upwind", "crosswind", "downwind", "base"].includes(tipoObjetivo)
        ? tipoObjetivo
        : null
    ) || obtenerProyeccionRutaMasCercana(
      { lat: aeronave.lat, lng: aeronave.lng },
      rutaActualizada
    )

    aeronave.ruta = rutaActualizada

    if (proyeccionTramo) {
      aeronave.tramoObjetivo = proyeccionTramo.indiceA
      aeronave.puntoIntercepto = proyeccionTramo.puntoIntercepto
      aeronave.ingresoDownwindWaypoints = null
      aeronave.ingresoDownwindTipo = null
      aeronave.estado = "INTERCEPTING ARC"
      reiniciarGuiadoInterceptacionCircuito(aeronave)
      aeronave.velocidad = aeronave.velocidad || (90 * 0.514444)
    } else {
      aeronave.estado = "CIRCUIT"
    }
  } else if (
    (aeronave.estado === "INTERCEPTING ARC" || aeronave.estado === "INTERCEPTING LEG") &&
    aeronave.ruta
  ) {
    aeronave.ingresoDownwindWaypoints = null
    aeronave.ingresoDownwindTipo = null
    aeronave.ruta = rutaActualizada

    const proyeccionTramo = obtenerProyeccionRutaMasCercana(
      { lat: aeronave.lat, lng: aeronave.lng },
      rutaActualizada
    )
    if (proyeccionTramo) {
      aeronave.tramoObjetivo = proyeccionTramo.indiceA
      aeronave.puntoIntercepto = proyeccionTramo.puntoIntercepto
      aeronave.estado = "INTERCEPTING LEG"
      reiniciarGuiadoInterceptacionCircuito(aeronave)
    }
  } else {
    aeronave.ruta = rutaActualizada
  }

  io.to(nombreSala).emit("rutaCircuitoActualizada", {
    id: aeronave.id,
    ruta: rutaActualizada,
    sentidoCircuito: normalizarSentidoCircuitoTexto(aeronave.circuitoSentido),
    shortCircuitoActivo: Boolean(aeronave.shortCircuitoActivo)
  })
  emitirActualizacionAeronave(nombreSala, aeronave)
})

socket.on("virarCircuito", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

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
  reiniciarGuiadoInterceptacionCircuito(aeronave)
  aeronave.velocidad = aeronave.velocidad || (90 * 0.514444)

  iniciarMotorSala(salaNombre)
})

socket.on("orbitarCircuito", ({ id, sentido } = {}) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

  const estadoCompatibleConCircuito =
    aeronave.estado === "CIRCUIT" ||
    aeronave.estado === "ORBT" ||
    aeronave.estado === "INTERCEPTING ARC" ||
    aeronave.estado === "INTERCEPTING LEG"

  const sentidoSolicitado = normalizarSentidoOrbitTexto(sentido)
  const sentidoActual = normalizarSentidoOrbitTexto(aeronave.orbitSentido)
  if (estadoCompatibleConCircuito && !Boolean(aeronave.orbitFueraCircuitoActivo)) {
    aeronave.pilotageObjetivoLat = null
    aeronave.pilotageObjetivoLng = null
    aeronave.pilotageMarkerTipo = null
  }
  if (!estadoCompatibleConCircuito) {
    if (!activarOrbitacionFueraCircuitoServidor(sala, aeronave, sentidoSolicitado)) return
    iniciarMotorSala(salaNombre)
    return
  }

  if (!aeronave.ruta || aeronave.ruta.length < 2) {
    aeronave.ruta = generarRutaServidorParaAeronave(sala, aeronave)
  }
  if (!aeronave.ruta || aeronave.ruta.length < 2) return

  if (aeronave.orbitEnCurso) {
    if (sentidoSolicitado !== sentidoActual) {
      aeronave.orbitSentido = sentidoSolicitado
      aeronave.orbitModoContinuo = true
      aeronave.orbitDetenerSolicitado = false
      iniciarMotorSala(salaNombre)
      return
    }

    const activarContinuo = !Boolean(aeronave.orbitModoContinuo)

    if (activarContinuo) {
      aeronave.orbitModoContinuo = true
      aeronave.orbitDetenerSolicitado = false
    } else {
      if (aeronave.orbitFueraCircuitoActivo) {
        limpiarOrbitacionAeronave(aeronave)
        aeronave.estado = "MANUAL"
        aeronave.ruta = null
        aeronave.indice = 0
        aeronave.progreso = 0
        aeronave.indiceObjetivo = null
        aeronave.tramoObjetivo = null
        aeronave.puntoIntercepto = null
        aeronave.ingresoDownwindWaypoints = null
        aeronave.ingresoDownwindTipo = null
        emitirActualizacionAeronave(salaNombre, aeronave)
        iniciarMotorSala(salaNombre)
        return
      }

      
      aeronave.orbitModoContinuo = false
      aeronave.orbitDetenerSolicitado = true
    }

    iniciarMotorSala(salaNombre)
    return
  }

  if (Boolean(aeronave.orbitPendiente) || Boolean(aeronave.orbitModoContinuo)) {
    if (sentidoSolicitado !== sentidoActual) {
      aeronave.orbitSentido = sentidoSolicitado
      aeronave.orbitModoContinuo = true
      aeronave.orbitDetenerSolicitado = false
      aeronave.orbitPendiente = true
      iniciarMotorSala(salaNombre)
      return
    }

    
    limpiarOrbitacionAeronave(aeronave)
    iniciarMotorSala(salaNombre)
    return
  }

  limpiarOrbitacionAeronave(aeronave)
  aeronave.orbitSentido = sentidoSolicitado
  aeronave.orbitPendiente = false
  aeronave.orbitEnCurso = true
  aeronave.orbitModoContinuo = true
  aeronave.orbitDetenerSolicitado = false
  aeronave.orbitAcumulado = 0
  aeronave.orbitFueraCircuitoActivo = false
  aeronave.estado = "ORBT"

  if (!Number.isFinite(aeronave.angulo)) {
    aeronave.angulo = RUMBOS_CIRCUITO.downwind
  }
  if (!Number.isFinite(aeronave.velocidad) || aeronave.velocidad <= 0) {
    aeronave.velocidad = 90 * 0.514444
  }

  iniciarMotorSala(salaNombre)
})


  
socket.on("actualizarAeronave", (data) => {

  const sala = socket.sala;
  if (!sala) return;

  const aeronave = salas[sala].aeronaves.find(a => a.id === data.id);
  if (!aeronave) return;

  
  if (!socketPuedeControlarAeronave(sala, salas[sala], aeronave, socket.id)) return;

  
  if (typeof data.lat !== "number") return;
  if (typeof data.lng !== "number") return;
  if (typeof data.altitud !== "number") return;
  if (typeof data.angulo !== "number") return;
  const estadoRecibido =
    typeof data.estado === "string" ? data.estado : aeronave.estado
  const movimientoAutoritativo =
    MOVIMIENTO_AUTORITATIVO_SERVIDOR && esEstadoMovimientoServidor(estadoRecibido)
  const permitirAltitudCliente =
    !movimientoAutoritativo ||
    estadoRecibido === "MANUAL" ||
    estadoRecibido === "AUTO" ||
    estadoRecibido === "PILOTAGE"
  const altitudAnterior = Number.isFinite(aeronave.altitud) ? aeronave.altitud : 0
  const altitudRecibida =
    permitirAltitudCliente && Number.isFinite(data.altitud)
      ? data.altitud
      : altitudAnterior
  const syncTsRecibido =
    typeof data.syncTs === "number" && Number.isFinite(data.syncTs)
      ? data.syncTs
      : null
  const huboCambioManualAltitud =
    Math.abs(altitudRecibida - altitudAnterior) > EPSILON_ALTITUD_MANUAL_CIRCUITO_FT

  if (
    huboCambioManualAltitud &&
    aeronave.altitudCircuitoAutomaticaActiva &&
    esEstadoCircuitoConAltitudAutomatica(estadoRecibido)
  ) {
    aeronave.altitudCircuitoAutomaticaActiva = false
  }

  const estadoPrevio = aeronave.estado
  if(typeof data.estado === "string"){
    aeronave.estado = data.estado
  }
  if(aeronave.estado !== "AIRBORNE"){
    reiniciarSecuenciaDespegueAeronave(aeronave)
  }
  if(
    estadoPrevio === "TAXI" &&
    aeronave.estado !== "TAXI" &&
    aeronave.movimiento
  ){
    aeronave.movimiento = null
  }

  if (!movimientoAutoritativo) {
    aeronave.lat = data.lat;
    aeronave.lng = data.lng;
  }
  aeronave.altitud = altitudRecibida;
  const permitirAnguloCliente =
    !movimientoAutoritativo ||
    estadoRecibido === "MANUAL" ||
    estadoRecibido === "AUTO" ||
    estadoRecibido === "PILOTAGE"
  if (permitirAnguloCliente) {
    aeronave.angulo = data.angulo;
  }
  if (
    typeof data.orbitSentido === "string" ||
    (typeof data.orbitSentido === "number" && Number.isFinite(data.orbitSentido))
  ) {
    aeronave.orbitSentido = normalizarSentidoOrbitTexto(data.orbitSentido)
  }
  if (typeof data.velocidad === "number" && Number.isFinite(data.velocidad)) {
    aeronave.velocidad = Math.max(0, data.velocidad);
  }
  if (
    typeof data.velocidadObjetivo === "number" &&
    Number.isFinite(data.velocidadObjetivo)
  ) {
    aeronave.velocidadObjetivo = Math.max(0, data.velocidadObjetivo);
  }
  if (
    typeof data.altitudObjetivo === "number" &&
    Number.isFinite(data.altitudObjetivo)
  ) {
    aeronave.altitudObjetivo = Math.max(0, data.altitudObjetivo);
  }
  if(Object.prototype.hasOwnProperty.call(data, "fase")){
    aeronave.fase =
      aeronave.estado === "AIRBORNE"
        ? normalizarFaseDespegue(data.fase)
        : null
  }
  if(Object.prototype.hasOwnProperty.call(data, "takeoffRollProgressM")){
    aeronave.takeoffRollProgressM =
      aeronave.estado === "AIRBORNE" &&
      Number.isFinite(Number(data.takeoffRollProgressM))
        ? Math.max(0, Number(data.takeoffRollProgressM))
        : 0
  }
  actualizarObjetivoPilotageServidor(aeronave, data)
  if(Object.prototype.hasOwnProperty.call(data, "arrivalProcedureName")){
    aeronave.arrivalProcedureName =
      normalizarNombreProcedimientoLlegadaServidor(data.arrivalProcedureName)
    aeronave.arrivalAltitudeProfile = construirPerfilAltitudLlegadaServidor(aeronave)
  }
  if(Object.prototype.hasOwnProperty.call(data, "rutaAirborneLoop")){
    aeronave.rutaAirborneLoop = Boolean(data.rutaAirborneLoop)
  }
  if(Object.prototype.hasOwnProperty.call(data, "rutaAirborneLoopStartIndex")){
    aeronave.rutaAirborneLoopStartIndex =
      normalizarIndiceLoopRutaAirborneServidor(data.rutaAirborneLoopStartIndex)
  }
  const claveProcedimientoLlegada = obtenerClaveProcedimientoLlegadaServidor(
    aeronave.arrivalProcedureName
  )
  if(
    claveProcedimientoLlegada !== PROCEDIMIENTO_LLEGADA_GEBED3_HOLDING_MUMOP_CLAVE ||
    !Boolean(aeronave.rutaAirborneLoop)
  ){
    aeronave.arrivalHoldingMumopManualAltitudeFt = null
  } else if(
    estadoRecibido === "AIRBORNE" &&
    typeof data.altitudObjetivo === "number" &&
    Number.isFinite(data.altitudObjetivo)
  ){
    aeronave.arrivalHoldingMumopManualAltitudeFt = Math.max(
      ALTITUD_MINIMA_HOLDING_MUMOP_FT,
      Number(data.altitudObjetivo)
    )
  }
  if(syncTsRecibido !== null){
    aeronave.syncTs = syncTsRecibido
  }
  if (MOVIMIENTO_AUTORITATIVO_SERVIDOR && esEstadoMovimientoServidor(aeronave.estado)) {
    iniciarMotorSala(sala)
  }

  socket.to(sala).emit(
    "actualizarAeronave",
    construirPayloadActualizacionAeronave(aeronave)
  )


});
socket.on("activarManual", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return
  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

  if (aeronave.estado === "PILOTAGE") return

  limpiarOrbitacionAeronave(aeronave)

  if (aeronave.estado === "MANUAL") {

    
    aeronave.estado = "AUTO"

  } else {

    
    aeronave.estado = "MANUAL"

    aeronave.ruta = null
    aeronave.indice = 0
    aeronave.progreso = 0
    aeronave.indiceObjetivo = null

  }

  iniciarMotorSala(salaNombre)

  aeronave.syncTs = Date.now()
  io.to(
    salaNombre
  ).emit("actualizarAeronave", construirPayloadActualizacionAeronave(aeronave))
})
socket.on("detenerAccionAeronave", ({ id } = {}) => {

  const salaNombre = socket.sala
  if(!salaNombre) return

  const sala = salas[salaNombre]
  if(!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if(!aeronave) return
  if(!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

  detenerAccionActualAeronave(aeronave)
  const rutaCircuitoBase = generarRutaServidorParaAeronave(sala, aeronave)
  io.to(salaNombre).emit("rutaCircuitoActualizada", {
    id: aeronave.id,
    ruta: rutaCircuitoBase,
    sentidoCircuito: normalizarSentidoCircuitoTexto(aeronave.circuitoSentido),
    shortCircuitoActivo: false,
    extensionAeronave: {
      upwind: 0,
      downwind: 0
    }
  })
  emitirActualizacionAeronave(salaNombre, aeronave, {
    detenida: true
  })
})

socket.on("iniciarCircuito", ({ id, modoIngreso, sentidoCircuito } = {}) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return
  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return
  if (
  aeronave.estado === "CIRCUIT" ||
  aeronave.estado === "INTERCEPTING ARC" ||
  aeronave.estado === "INTERCEPTING LEG"
) return

  limpiarGoAroundAeronave(aeronave)
  prepararAeronaveParaCircuito(salaNombre, sala, aeronave, {
    modoIngreso,
    sentidoCircuito
  })
})
socket.on("iniciarGoAround", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

  if (!puedeActivarGoAroundEnFinal(sala, aeronave)) {
    socket.emit("goAroundRechazado", {
      id: aeronave.id,
      motivo: "FINAL_ONLY"
    })
    return
  }

  inicializarGoAroundAeronave(aeronave)
  aeronave.goAroundFase = "TO_RADIAL"
  aeronave.estado = "GO AROUND"

  limpiarOrbitacionAeronave(aeronave)
  aeronave.ruta = null
  aeronave.indice = 0
  aeronave.progreso = 0
  aeronave.tramoObjetivo = null
  aeronave.puntoIntercepto = null
  aeronave.ingresoDownwindWaypoints = null
  aeronave.ingresoDownwindTipo = null

  if (
    !Number.isFinite(aeronave.velocidadObjetivo) ||
    aeronave.velocidadObjetivo <= 0
  ) {
    aeronave.velocidadObjetivo = GO_AROUND_SPEED_DEFAULT_KT
  }

  if (!Number.isFinite(aeronave.velocidad) || aeronave.velocidad <= 0) {
    aeronave.velocidad = aeronave.velocidadObjetivo * 0.514444
  }

  emitirActualizacionAeronave(salaNombre, aeronave)
  iniciarMotorSala(salaNombre)
})
socket.on("detenerCircuito", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

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
  if (!socketPuedeControlarAeronave(salaNombre, sala, aeronave, socket.id)) return

  

  limpiarGoAroundAeronave(aeronave)
  limpiarOrbitacionAeronave(aeronave)
  aeronave.ruta = null
  aeronave.indice = 0
  aeronave.progreso = 0
  aeronave.indiceObjetivo = null
  aeronave.puntoIngreso = null
  aeronave.rutaAirborne = null
  aeronave.rutaAirborneFinalizada = false
  aeronave.rutaAirborneIndice = 0
  aeronave.rutaAirborneProgreso = 0
  aeronave.rutaAirborneLoop = false
  aeronave.rutaAirborneLoopStartIndex = 0
  aeronave.arrivalProcedureName = null
  aeronave.arrivalAltitudeProfile = null
  aeronave.arrivalHoldingMumopManualAltitudeFt = null

  
  if (aeronave.estado === "MANUAL") {
    aeronave.velocidad = aeronave.velocidad || (90 * 0.514444)
  }

  
  aeronave.estado = "LANDING"

  aeronave.syncTs = Date.now()
  io.to(
    salaNombre
  ).emit("actualizarAeronave", construirPayloadActualizacionAeronave(aeronave))

})
  
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

  if (!socketPuedeControlarAeronave(salaNombre, sala, a, socket.id)) return

  const estadoActual = a.estado
  const esManual = estadoActual === "MANUAL"
  const esAuto = estadoActual === "AUTO"
  const esCircuito =
    estadoActual === "CIRCUIT" ||
    estadoActual === "ORBT" ||
    estadoActual === "INTERCEPTING ARC" ||
    estadoActual === "INTERCEPTING LEG"
  const ajustePermitido =
    tipo === "speed" ||
    (tipo === "heading" && esManual) ||
    (tipo === "altitude" && (esManual || esAuto || esCircuito))

  if (!ajustePermitido) return

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
    if (esCircuito && a.altitudCircuitoAutomaticaActiva) {
      a.altitudCircuitoAutomaticaActiva = false
    }
    a.altitud = Math.max(0, a.altitud + valor)
    if (estadoActual === "ORBT") {
      a.altitudObjetivo = a.altitud
    }
  }

  emitirActualizacionAeronave(salaNombre, a)

})
socket.on("setSpeedKnots", ({ id, speedKnots }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  if (!sala) return

  const a = sala.aeronaves.find(av => av.id === id)
  if (!a) return

  if (!socketPuedeControlarAeronave(salaNombre, sala, a, socket.id)) return

  if (typeof speedKnots !== "number" || !Number.isFinite(speedKnots)) return

  const speedSafe = Math.max(0, Math.min(SPEED_CONTROL_MAX_KNOTS, speedKnots))
  a.velocidad = speedSafe * 0.514444
  a.velocidadObjetivo = speedSafe

  emitirActualizacionAeronave(salaNombre, a)

})
  
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
    const estabaPausado = reloj.pausado;
    reloj.pausado = false;
    reloj.timestampBase = Date.now();

    const horaActual = obtenerHoraActualSala(sala);
    const segundosActuales = convertirHoraObjetoASegundos(horaActual);

    if (estabaPausado) {
      const horaPlayTexto = horaObjetoATexto(horaActual);
      if (horaPlayTexto) {
        reloj.panelHoraInicio = horaPlayTexto;
      }
    }

    if (estabaPausado && !reloj.letraAsignada) {
      reloj.letraActual = generarLetraAleatoriaAZ();
      reloj.letraAsignada = true;
      reloj.segundosAcumuladosLetra = 0;
      reloj.ultimoSegundoLetra = Number.isFinite(segundosActuales)
        ? segundosActuales
        : null;
      io.to(sala).emit("letraPanelSala", { letra: reloj.letraActual });
    } else if (estabaPausado && Number.isFinite(segundosActuales)) {
      reloj.ultimoSegundoLetra = segundosActuales;
    }
  }

  
  reloj.velocidad = 1;

  
  io.to(sala).emit("estadoTiempo", {
    pausado: reloj.pausado,
    panelHora: reloj.panelHoraInicio || null
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

  
socket.on("disconnect", () => {

  modosOperacionPorSocket.delete(socket.id)

  for (let nombre in salas) {

    const aeronavesLiberadas = []
	    salas[nombre].aeronaves.forEach((aeronave) => {
	      if(!aeronave) return
	      if(aeronave.owner !== socket.id) return

	      aeronave.owner = null
	      if(aeronave.estado === "AIRBORNE"){
	        resincronizarRutaAirborneDesdePos(aeronave)
	      } else if (
	        aeronave.estado === "PILOTAGE" &&
	        !aeronave.movimiento &&
	        aeronave.pilotageMarkerTipo === "orbit"
	      ) {
	        if (
	          activarOrbitacionFueraCircuitoServidor(
	            salas[nombre],
	            aeronave,
	            aeronave.orbitSentido
	          )
	        ) {
	          emitirActualizacionAeronave(nombre, aeronave)
	        }
	      }
	      aeronavesLiberadas.push(aeronave.id)
	    })
    if(aeronavesLiberadas.length > 0){
      io.to(nombre).emit("aeronavesLiberadas", {
        ids: aeronavesLiberadas
      })
      iniciarMotorSala(nombre)
    }

    salas[nombre].jugadores =
      salas[nombre].jugadores.filter(id => id !== socket.id);

    
    if (salas[nombre].jugadores.length === 0) {

      
      if (timeoutsSalas[nombre]) return;

      console.log(` Sala ${nombre} vacía. Eliminando en 5 horas si nadie entra.`);

      timeoutsSalas[nombre] = setTimeout(() => {

        
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

      }, 5 * 60 * 60 * 1000); 
    }
  }

  io.emit("listaSalas", obtenerListaSalas());
});



});




server.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

