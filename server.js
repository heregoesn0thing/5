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

      // =====================================
      // RESTO DE LÓGICA (requiere ruta)
      // =====================================

      if (!a.ruta || a.ruta.length < 2) return

      const velocidadMPS = a.velocidad || (90 * 0.514444)
      const distanciaTick = velocidadMPS * (intervaloMS/1000)

      // =====================================
      // ✈ FASE 1 — INTERCEPTANDO EL CIRCUITO
      // =====================================
      if (a.estado === "interceptando") {

        const destino = a.ruta[a.indiceObjetivo]

        const distancia = distanciaEntre(
          { lat: a.lat, lng: a.lng },
          destino
        )

        if (distancia <= distanciaTick) {

          a.lat = destino.lat
          a.lng = destino.lng

          a.indice = a.indiceObjetivo
          a.progreso = 0
          a.estado = "circuito"

        } else {

          const rumboDeseado = calcularRumboServidor(
            { lat: a.lat, lng: a.lng },
            destino
          )

          const fraccion = distanciaTick / distancia

          a.lat += (destino.lat - a.lat) * fraccion
          a.lng += (destino.lng - a.lng) * fraccion

          if (a.angulo === undefined || a.angulo === null) {
            a.angulo = rumboDeseado
          } else {

            const diff = diferenciaAngular(a.angulo, rumboDeseado)
            const maxGiro = 3

            if (Math.abs(diff) <= maxGiro) {
              a.angulo = rumboDeseado
            } else {
              a.angulo += Math.sign(diff) * maxGiro
            }

            a.angulo = (a.angulo + 360) % 360
          }
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

      // =====================================
      // ✈ FASE 2 — MOVIMIENTO NORMAL EN CIRCUITO
      // =====================================
      if (a.estado !== "circuito") return

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

  const lateralM = 1.5 * 1852

  // 🔥 EXTENSIÓN DINÁMICA
  const extensionBase = 2.5 * 1852
  const extensionExtra = sala.extensionExtra || 0
  const extensionM = extensionBase + extensionExtra

  const finalExt = puntoPlano(umbral22, rumboPista, extensionM)
  const salidaExt = puntoPlano(umbral04, rumboInverso, extensionM)

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
function diferenciaAngular(actual, destino) {
  return (destino - actual + 540) % 360 - 180
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
      extensionExtra: 0 
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

    // 🔥 SINCRONIZAR INMEDIATAMENTE
    const horaActual = obtenerHoraActualSala(nombre);
    if (horaActual) {
      socket.emit("horaSala", horaActual);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

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

  // Sumar extensión
  sala.extensionExtra += metros

  // Regenerar ruta para todas las aeronaves en circuito
  sala.aeronaves.forEach(a => {

    if (a.estado !== "circuito") return

    a.ruta = generarRutaServidor(sala)

    // reajustar índice al punto más cercano
    let indiceMasCercano = 0
    let menorDistancia = Infinity

    a.ruta.forEach((p, i) => {

      const d = distanciaEntre(
        { lat: a.lat, lng: a.lng },
        p
      )

      if (d < menorDistancia) {
        menorDistancia = d
        indiceMasCercano = i
      }
    })

    a.indice = indiceMasCercano
    a.progreso = 0
  })

  // Enviar nueva ruta a todos
  io.to(nombreSala).emit("rutaCircuitoActualizada", {
    extensionExtra: sala.extensionExtra
  })

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
  if (aeronave.estado === "circuito" || aeronave.estado === "interceptando") return

  // 🔥 GENERAR RUTA
  aeronave.ruta = generarRutaServidor(sala)

  // 🔥 ENVIAR RUTA A LOS CLIENTES (AQUÍ VA)
  io.to(salaNombre).emit("rutaCircuito", {
    ruta: aeronave.ruta
  })

  // Buscar punto más cercano
  let indiceMasCercano = 0
  let menorDistancia = Infinity

  aeronave.ruta.forEach((p, i) => {

    const d = distanciaEntre(
      { lat: aeronave.lat, lng: aeronave.lng },
      p
    )

    if (d < menorDistancia) {
      menorDistancia = d
      indiceMasCercano = i
    }
  })

  aeronave.indiceObjetivo = indiceMasCercano
  aeronave.velocidad = 90 * 0.514444
  aeronave.estado = "interceptando"

  iniciarMotorSala(salaNombre)
})
socket.on("detenerCircuito", ({ id }) => {

  const salaNombre = socket.sala
  if (!salaNombre) return

  const sala = salas[salaNombre]
  const aeronave = sala.aeronaves.find(a => a.id === id)
  if (!aeronave) return

  if (aeronave.owner !== socket.id) return

  aeronave.estado = "idle"
  aeronave.ruta = null
  aeronave.indice = 0
  aeronave.progreso = 0
  aeronave.indiceObjetivo = null

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
    a.velocidad = Math.max(0, (a.velocidad || 200) + valor)
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