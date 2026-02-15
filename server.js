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

// 🔥 Solo estructura básica de salas
let salas = {};

function obtenerListaSalas() {
  return Object.keys(salas).map(nombre => ({
    nombre,
    jugadores: salas[nombre].length
  }));
}

io.on("connection", (socket) => {

  console.log("Nuevo usuario:", socket.id);

  // Enviar lista actual
  socket.emit("listaSalas", obtenerListaSalas());

  // Crear sala
  socket.on("crearSala", (nombre) => {
    if (!salas[nombre]) {
      salas[nombre] = [];
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

  // Unirse a sala
  socket.on("unirseSala", (nombre) => {

    if (!salas[nombre]) return;

    socket.join(nombre);

    if (!salas[nombre].includes(socket.id)) {
      salas[nombre].push(socket.id);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

  // Al desconectarse
  socket.on("disconnect", () => {

    for (let nombre in salas) {
      salas[nombre] = salas[nombre].filter(id => id !== socket.id);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

});

server.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});


























