const express = require("express")
const cors = require("cors")
const morgan = require("morgan")
const { v4: uuidv4 } = require("uuid")
const dotenv = require("dotenv")
const pgp = require("pg-promise")()
const jwt = require("jsonwebtoken")
const amqp = require("amqplib/callback_api")
const bcrypt = require("bcryptjs")
const prom_client = require("prom-client")

const register = new prom_client.Registry()

const createCounter = (name, help) => {
  const counter = new prom_client.Counter({ name, help })
  register.registerMetric(counter)
  return counter
}

const created_user = createCounter("create_user_counter", "Counter for the number of users created")
const updated_user = createCounter("update_user_counter", "Counter for the number of users updated")
const deleted_user = createCounter("delete_user_counter", "Counter for the number of users deleted")
const read_user = createCounter("read_user_counter", "Counter for the number of users read")

register.setDefaultLabels({
  app: "user-service",
})

prom_client.collectDefaultMetrics({ register })

const app = express()

dotenv.config()

app.use(express.json())
app.use(
  cors({
    origin: "*",
  })
)
app.use(morgan("dev"))

const connectToDatabase = async (retries = 5, delay = 5000) => {
  while (retries) {
    try {
      const db = pgp(process.env.DATABASE_URL)
      await db.connect()
      console.log("Connected to the database")

      // Create the users table if it doesn't exist
      await db.none(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY,
          username VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `)
      console.log("Table 'users' created successfully")

      return db
    } catch (error) {
      console.error("Failed to connect to the database, retrying...", error)
      retries -= 1
      await new Promise((res) => setTimeout(res, delay))
    }
  }
  throw new Error("Could not connect to the database after multiple attempts")
}

const connectToRabbitMQ = () => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("RabbitMQ connection timeout"))
    }, 5000) // 5 seconds timeout

    amqp.connect(process.env.RABBITMQ_URL, (error0, connection) => {
      clearTimeout(timeout)
      if (error0) {
        reject(error0)
      } else {
        resolve(connection)
      }
    })
  })
}

connectToDatabase()
  .then((db) => {
    app.use(express.json())

    app.get('/metrics', async (req, res) => {
      res.setHeader('Content-type', register.contentType);
      res.end(await register.metrics());
    });

    app.get("/", (req, res) => {
      res.json("user service")
    })

    connectToRabbitMQ()
      .then((connection) => {
        connection.createChannel((error1, channel) => {
          if (error1) {
            throw error1
          }
          const queue = "user_created"

          channel.assertQueue(queue, {
            durable: false,
          })

          // Register a new user
          app.post("/auth/register", async (req, res) => {
            const { username, password } = req.body
            if (!username || !password) {
              return res.status(400).json({ message: "Username and password are required" })
            }
            try {
              if (await db.oneOrNone("SELECT * FROM users WHERE username = $1", [username])) {
                return res.status(400).json({ message: "Username already exists" })
              }
              const hashedPassword = await bcrypt.hash(password, 10)
              const userId = uuidv4()
              await db.none("INSERT INTO users(id, username, password) VALUES($1, $2, $3)", [userId, username, hashedPassword])
              created_user.inc()
              res.status(201).json({ message: "User registered successfully" })

              // Send message to RabbitMQ
              const user = { username }
              channel.sendToQueue(queue, Buffer.from(JSON.stringify(user)))
              console.log(" [x] Sent %s", user)
            } catch (error) {
              res.status(500).json({ error: error.message })
            }
          })

          // Login a user
          app.post("/auth/login", async (req, res) => {
            const { username, password } = req.body
            if (!username || !password) {
              return res.status(400).json({ message: "Username and password are required" })
            }
            try {
              const user = await db.oneOrNone("SELECT * FROM users WHERE username = $1", [username])
              if (user && (await bcrypt.compare(password, user.password))) {
                const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
                  expiresIn: "1h",
                })
                res.status(200).json({ message: "Login successful", token, userId: user.id })
              } else {
                res.status(401).json({ message: "Invalid username or password" })
              }
            } catch (error) {
              res.status(500).json({ error: error.message })
            }
          })

          // Read all users
          app.get("/all", (req, res) => {
            db.any("SELECT * FROM users")
              .then((data) => {
                read_user.inc()
                res.status(200).json(data)
              })
              .catch((error) => {
                res.status(500).json({ error: error.message })
              })
          })

          // Update a user
          app.patch("/user/:id", async (req, res) => {
            const { id } = req.params
            const { username, password } = req.body
            try {
              const hashedPassword = await bcrypt.hash(password, 10)
              await db.none("UPDATE users SET username=$1, password=$2 WHERE id=$3", [username, hashedPassword, id])
              updated_user.inc()
              res.status(200).json({ message: "User updated successfully" })
            } catch (error) {
              res.status(500).json({ error: error.message })
            }
          })

          // Delete a user
          app.delete("/user/:id", (req, res) => {
            const { id } = req.params
            db.none("DELETE FROM users WHERE id=$1", [id])
              .then(() => {
                deleted_user.inc()
                res.status(204).json({ message: "User deleted successfully" })
              })
              .catch((error) => {
                res.status(500).json({ error: error.message })
              })
          })

          // Get all users
          app.get("/users", (req, res) => {
            db.any("SELECT * FROM users")
              .then((data) => {
                read_user.inc()
                res.status(200).json(data)
              })
              .catch((error) => {
                res.status(500).json({ error: error.message })
              })
          })

          app.listen(process.env.PORT, () => {
            console.log(`Example app listening at ${process.env.APP_URL}:${process.env.PORT}`)
          })
        })
      })
      .catch((error) => {
        console.error("Failed to connect to RabbitMQ:", error)
      })
  })
  .catch((error) => {
    console.error("Failed to start the server:", error)
  })