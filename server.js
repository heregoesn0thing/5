const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Sirve los archivos HTML desde la raíz del proyecto
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/sala", (req, res) => {
  res.sendFile(__dirname + "/sala.html");
});


// 🔥 Almacén de salas en memoria
let salas = {};
const LIMITE_USUARIOS = 2;

// 📌 Devuelve la lista de salas con cantidad de jugadores
function obtenerListaSalas() {
  return Object.keys(salas).map(nombre => ({
    nombre,
    jugadores: salas[nombre].jugadores.length
  }));
}

io.on("connection", (socket) => {
  console.log("Nuevo usuario conectado:", socket.id);

  // 🔹 Enviar lista actual de salas al usuario nuevo
  socket.emit("listaSalas", obtenerListaSalas());

  // 🔹 Crear sala
  socket.on("crearSala", (nombre) => {
    if (!salas[nombre]) {
      salas[nombre] = { jugadores: [] };
      console.log("Sala creada:", nombre);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });

  // 🔹 Unirse a sala
  socket.on("unirseSala", (nombre) => {
    if (!salas[nombre]) return;

    const sala = salas[nombre];

    // 🔥 Verificar límite
    if (sala.jugadores.length >= LIMITE_USUARIOS) {
      socket.emit("salaLlena");
      return;
    }

    socket.join(nombre);

    if (!sala.jugadores.includes(socket.id)) {
      sala.jugadores.push(socket.id);
    }

    console.log(socket.id, "se unió a", nombre);

    io.emit("listaSalas", obtenerListaSalas());
  });

  // 🔹 Dibujar en tiempo real
  socket.on("dibujar", (data) => {
    socket.to(data.sala).emit("dibujar", data);
  });

  // 🔹 Limpiar pizarra
  socket.on("limpiar", (nombre) => {
    socket.to(nombre).emit("limpiar");
  });

  // 🔹 Desconexión
  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);

    for (let nombre in salas) {
      salas[nombre].jugadores =
        salas[nombre].jugadores.filter(id => id !== socket.id);
    }

    io.emit("listaSalas", obtenerListaSalas());
  });
});

// 🚀 Servidor en puerto dinámico (PRODUCCIÓN)
server.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});
























