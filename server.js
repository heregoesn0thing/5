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
  socket.on("crearSala", ({ nombre, horaInicial }) => {

  if (!salas[nombre]) {

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
      intervalo: null
    };

    iniciarRelojSala(nombre);
  }

  io.emit("listaSalas", obtenerListaSalas());
});


  // ================= UNIRSE =================
  socket.on("unirseSala", (nombre) => {

  if (!salas[nombre]) return;

  socket.join(nombre);
  const reloj = relojesSalas[nombre];

if (reloj) {
  const ahora = Date.now();
  const delta = (ahora - reloj.timestampBase)/1000 * reloj.velocidad;
  const tiempoActual = reloj.tiempoBase + delta;

  const horaFormateada = formatearHora(tiempoActual);
  socket.emit("horaSala", horaFormateada);
}

  socket.sala = nombre;

  if (!salas[nombre].jugadores.includes(socket.id)) {
    salas[nombre].jugadores.push(socket.id);
  }

  // Enviar aeronaves existentes
  socket.emit("cargarAeronaves", salas[nombre].aeronaves);


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
socket.on("controlTiempo", ({ sala, accion, valor }) => {

  const reloj = relojesSalas[sala]
  if(!reloj) return

  const ahora = Date.now()
  const delta = (ahora - reloj.timestampBase)/1000 * reloj.velocidad
  reloj.tiempoBase += delta
  reloj.timestampBase = ahora

  if(accion === "pausar"){
    reloj.pausado = true
  }

  if(accion === "reanudar"){
    reloj.pausado = false
  }

  if(accion === "velocidad"){
    reloj.velocidad = valor
  }
})


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
function convertirHoraASegundos(horaStr){
  const [h,m,s] = horaStr.split(":").map(Number)
  return h*3600 + m*60 + (s || 0)
}

function formatearHora(segundosTotales){

  segundosTotales = Math.floor(segundosTotales % 86400)

  const h = Math.floor(segundosTotales/3600).toString().padStart(2,'0')
  const m = Math.floor((segundosTotales%3600)/60).toString().padStart(2,'0')
  const s = Math.floor(segundosTotales%60).toString().padStart(2,'0')

  return { horas:h, minutos:m, segundos:s }
}

function iniciarRelojSala(nombre){

  const reloj = relojesSalas[nombre]

  reloj.intervalo = setInterval(()=>{

    if(reloj.pausado) return

    const ahora = Date.now()
    const delta = (ahora - reloj.timestampBase)/1000 * reloj.velocidad

    reloj.tiempoBase += delta
    reloj.timestampBase = ahora

    const horaFormateada = formatearHora(reloj.tiempoBase)

    io.to(nombre).emit("horaSala", horaFormateada)

  },1000)
}





























