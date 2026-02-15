const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const LIMITE_USUARIOS = 2;

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/sala", (req, res) => {
  res.sendFile(path.join(__dirname, "sala.html"));
});

let salas = {};
// Estructura:
// salas = {
//   nombreSala: {
//      jugadores: [socketId1, socketId2]
//   }
// }

function obtenerListaSalas() {
  return Object.keys(salas).map(nombre => ({
    nombre,
    cantidad: salas[nombre].jugadores.length,
    limite: LIMITE_USUARIOS
  }));
}

io.on("connection", (socket) => {

  console.log("Nuevo usuario conectado:", socket.id);

  // Enviar lista actual al nuevo usuario
  socket.emit("listaSalas", obtenerListaSalas());

  // Crear sala
  socket.on("crearSala", (nombre) => {
    if (!nombre) return;

    if (!salas[nombre]) {
      salas[nombre] = {
        jugadores: []
      };
      console.log("Sala creada:", nombre);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

  // Unirse a sala
  socket.on("unirseSala", (nombre) => {
    if (!salas[nombre]) return;

    const sala = salas[nombre];

    if (sala.jugadores.length >= LIMITE_USUARIOS) {
      socket.emit("salaLlena");
      return;
    }

    socket.join(nombre);

    if (!sala.jugadores.includes(socket.id)) {
      sala.jugadores.push(socket.id);
      console.log(socket.id, "se unió a", nombre);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

  // Dibujar en tiempo real
  socket.on("dibujar", ({ sala, x0, y0, x1, y1 }) => {
    socket.to(sala).emit("dibujar", { x0, y0, x1, y1 });
  });

  // Desconexión
  socket.on("disconnect", () => {
  console.log("Usuario desconectado:", socket.id);

  for (let nombre in salas) {
    salas[nombre].jugadores =
      salas[nombre].jugadores.filter(id => id !== socket.id);
  }

  io.emit("listaSalas", obtenerListaSalas());
});


});

server.listen(3000, () => {
  console.log("Servidor corriendo en http://localhost:3000");
});






















