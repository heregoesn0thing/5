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

  setInterval(() => {

    const hora = obtenerHoraActualSala(nombre);
    if (!hora) return;

    io.to(nombre).emit("horaSala", hora);

  }, 1000);
}


function obtenerHoraActualSala(nombre) {

  const reloj = relojesSalas[nombre];
  if (!reloj) return null;

  let segundosTranscurridos;

  if (reloj.pausado) {
    segundosTranscurridos = reloj.tiempoPausado;
  } else {
    segundosTranscurridos =
      (Date.now() - reloj.momentoInicio) / 1000 * reloj.velocidad;
  }

  const total = reloj.tiempoInicio + segundosTranscurridos;

  return formatearHora(total);
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
  tiempoInicio: segundosIniciales,
  momentoInicio: Date.now(),
  velocidad: 1,
  pausado: false,
  tiempoPausado: 0
};


    iniciarRelojSala(nombre);

    io.emit("listaSalas", obtenerListaSalas());
  });

  // ===== UNIRSE A SALA =====
  socket.on("unirseSala", (nombre) => {

    if (!salas[nombre]) return;

    socket.join(nombre);
    socket.sala = nombre;

    if (!salas[nombre].jugadores.includes(socket.id)) {
      salas[nombre].jugadores.push(socket.id);
    }

    socket.emit("cargarAeronaves", salas[nombre].aeronaves);

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
      tipo: data.tipo,
      lat: data.lat,
      lng: data.lng,
      altitud: data.altitud || 0,
      angulo: data.angulo || 0
    });

    socket.to(sala).emit("crearAeronave", data);
  });

  // ===== ACTUALIZAR AERONAVE =====
  socket.on("actualizarAeronave", (data) => {

    const sala = socket.sala;
    if (!sala) return;

    const aeronave = salas[sala].aeronaves.find(a => a.id === data.id);
    if (!aeronave) return;

    aeronave.lat = data.lat;
    aeronave.lng = data.lng;
    aeronave.altitud = data.altitud;
    aeronave.angulo = data.angulo;

    socket.to(sala).emit("actualizarAeronave", data);
  });

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

  const horaActual = obtenerHoraActualSala(sala);

  const segundosActuales =
    parseInt(horaActual.horas) * 3600 +
    parseInt(horaActual.minutos) * 60 +
    parseInt(horaActual.segundos);

  if (accion === "pausar" && !reloj.pausado) {
    reloj.pausado = true;
    reloj.tiempoPausado =
      (Date.now() - reloj.momentoInicio) / 1000 * reloj.velocidad;
  }

  if (accion === "reanudar" && reloj.pausado) {
    reloj.pausado = false;
    reloj.tiempoInicio = segundosActuales;
    reloj.momentoInicio = Date.now();
  }

  if (accion === "velocidad") {
    reloj.tiempoInicio = segundosActuales;
    reloj.momentoInicio = Date.now();
    reloj.velocidad = valor;
  }

});


  // ===== DESCONECTAR =====
  socket.on("disconnect", () => {

    for (let nombre in salas) {
      salas[nombre].jugadores =
        salas[nombre].jugadores.filter(id => id !== socket.id);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

});

// ================== INICIAR SERVIDOR ==================

server.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});





























