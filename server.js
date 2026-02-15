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

// 🔥 Salas con aeronaves
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

  // Crear sala
  socket.on("crearSala", (nombre) => {

    if (!salas[nombre]) {
      salas[nombre] = {
        jugadores: [],
        aeronaves: []
      };
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

  // Unirse a sala
  socket.on("unirseSala", (nombre) => {

    if (!salas[nombre]) return;

    socket.join(nombre);

    if (!salas[nombre].jugadores.includes(socket.id)) {
      salas[nombre].jugadores.push(socket.id);
    }

    // Enviar aeronaves existentes
    socket.emit("estadoAeronaves", salas[nombre].aeronaves);

    io.emit("listaSalas", obtenerListaSalas());
  });

  // Agregar aeronave
  socket.on("agregarAeronave", (data) => {

    const { sala, lat, lng } = data;
    if (!salas[sala]) return;

    const nueva = {
      id: Date.now() + Math.random(),
      lat,
      lng
    };

    salas[sala].aeronaves.push(nueva);

    io.to(sala).emit("aeronaveAgregada", nueva);
  });
// 🔥 Mover aeronave
socket.on("moverAeronave", (data) => {

  const { sala, id, lat, lng } = data;
  if (!salas[sala]) return;

  const aeronave = salas[sala].aeronaves.find(a => a.id === id);
  if (!aeronave) return;

  aeronave.lat = lat;
  aeronave.lng = lng;

  io.to(sala).emit("aeronaveMovida", aeronave);
});


// 🔥 Eliminar aeronave
socket.on("eliminarAeronave", (data) => {

  const { sala, id } = data;
  if (!salas[sala]) return;

  salas[sala].aeronaves =
    salas[sala].aeronaves.filter(a => a.id !== id);

  io.to(sala).emit("aeronaveEliminada", id);
});

  // Desconexión
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



























