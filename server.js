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
    const velocidadKT = 90
    const velocidadMPS = velocidadKT * 0.514444
    const distanciaPorTick = velocidadMPS * (intervaloMS/1000)

    sala.aeronaves.forEach(a => {

      if (a.estado !== "circuito") return
      if (!a.ruta) return

      const siguiente = (a.indice + 1) % a.ruta.length

      const A = a.ruta[a.indice]
      const B = a.ruta[siguiente]

      const distancia = distanciaEntre(A, B)

      a.progreso += distanciaPorTick

      if (a.progreso >= distancia){
        a.indice = siguiente
        a.progreso = 0
        return
      }

      const t = a.progreso / distancia

      a.lat = A.lat + (B.lat - A.lat) * t
      a.lng = A.lng + (B.lng - A.lng) * t

      a.angulo = calcularRumboServidor(A, B)

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
      aeronaves: []
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


  io.to(sala).emit("crearAeronave", data);


});



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

// ===== INICIAR CIRCUITO =====
socket.on("iniciarCircuito", ({ id }) => {

  const sala = socket.sala
  if (!sala) return

  const aeronave = salas[sala].aeronaves.find(a => a.id === id)
  if (!aeronave) return

  // Solo el dueño puede iniciar
  if (aeronave.owner !== socket.id) return

  aeronave.estado = "circuito"

  // Generar ruta si no existe
  if (!aeronave.ruta) {
    aeronave.ruta = generarRutaServidor()
    aeronave.indice = 0
    aeronave.progreso = 0
  }

  iniciarMotorSala(sala)
})

  // ===== ELIMINAR AERONAVE =====
  socket.on("eliminarAeronave", (id) => {

    const sala = socket.sala;
    if (!sala) return;

    salas[sala].aeronaves =
      salas[sala].aeronaves.filter(a => a.id !== id);

    io.to(sala).emit("borrarAeronave", id);
  });

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