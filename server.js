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

    // Enviar aeronaves existentes al nuevo usuario
    socket.emit("cargarAeronaves", salas[nombre].aeronaves);

    io.emit("listaSalas", obtenerListaSalas());
  });

  // ================= CREAR AERONAVE =================
  socket.on("crearAeronave", (data) => {

    const sala = socket.sala;
    if (!sala) return;

    salas[sala].aeronaves.push(data);

    io.to(sala).emit("crearAeronave", data);
  });

  // ================= ACTUALIZAR =================
  socket.on("actualizarAeronave", (data) => {

    const sala = socket.sala;
    if (!sala) return;

    io.to(sala).emit("actualizarAeronave", data);
  });

  // ================= ELIMINAR =================
  socket.on("eliminarAeronave", (id) => {

    const sala = socket.sala;
    if (!sala) return;

    salas[sala].aeronaves =
      salas[sala].aeronaves.filter(a => a.id !== id);

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



























