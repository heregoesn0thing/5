const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const relojesSalas = {}

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/sala", (req, res) => {
  res.sendFile(__dirname + "/sala.html");
});

// ================= SALAS =================

let salas = {};

function obtenerListaSalas() {
  return Object.keys(salas).map(nombre => ({
    nombre,
    jugadores: salas[nombre].jugadores.length
  }));
}

io.on("connection", (socket) => {

  console.log("Nuevo usuario:", socket.id);

  socket.emit("listaSalas", obtenerListaSalas());

  // ================= CREAR SALA =================
  socket.on("crearSala", (nombre) => {

    if (!salas[nombre]) {
      salas[nombre] = {
        jugadores: [],
        aeronaves: []
      };
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

  // ================= UNIRSE =================
  socket.on("unirseSala", (nombre) => {

  if (!salas[nombre]) return;

  socket.join(nombre);
  socket.sala = nombre;

  if (!salas[nombre].jugadores.includes(socket.id)) {
    salas[nombre].jugadores.push(socket.id);
  }

  // Enviar aeronaves existentes
  socket.emit("cargarAeronaves", salas[nombre].aeronaves);

  // ================= RELOJ POR SALA =================
  if (!relojesSalas[nombre]) {

    relojesSalas[nombre] = {
      intervalo: null
    };

    relojesSalas[nombre].intervalo = setInterval(() => {

      const ahora = new Date();

      const horaUTC = {
        horas: ahora.getUTCHours().toString().padStart(2,'0'),
        minutos: ahora.getUTCMinutes().toString().padStart(2,'0'),
        segundos: ahora.getUTCSeconds().toString().padStart(2,'0')
      };

      io.to(nombre).emit("horaSala", horaUTC);

    }, 1000);
  }

  io.emit("listaSalas", obtenerListaSalas());
});


  // ================= CREAR AERONAVE =================
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



 // ================= ACTUALIZAR =================
socket.on("actualizarAeronave", (data) => {

  const sala = socket.sala;
  if (!sala) return;

  const aeronave = salas[sala].aeronaves.find(a => a.id === data.id);
  if (!aeronave) return;

  // Actualizar datos guardados en el servidor
  aeronave.lat = data.lat;
  aeronave.lng = data.lng;
  aeronave.altitud = data.altitud;
  aeronave.angulo = data.angulo;

  // Enviar solo a los demás (no al emisor)
  socket.to(sala).emit("actualizarAeronave", data);
});


  // ================= ELIMINAR =================
socket.on("eliminarAeronave", (id) => {

  const sala = socket.sala;
  if (!sala) return;

  salas[sala].aeronaves =
    salas[sala].aeronaves.filter(a => a.id !== id);

  // Enviar a TODOS en la sala (incluido quien lo eliminó)
  io.to(sala).emit("borrarAeronave", id);
});



  // ================= DESCONECTAR =================
  socket.on("disconnect", () => {

    for (let nombre in salas) {
      salas[nombre].jugadores =
        salas[nombre].jugadores.filter(id => id !== socket.id);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

});


server.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});



























