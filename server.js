const express = require("express");
const dotenv = require("dotenv");
const pgp = require("pg-promise")();
const jwt = require("jsonwebtoken");
const app = express();

dotenv.config();

const connectToDatabase = async (retries = 5, delay = 5000) => {
  while (retries) {
    try {
      const db = pgp(process.env.DATABASE_URL);
      await db.connect();
      console.log("Connected to the database");

      // Create the users table if it doesn't exist
      await db.none(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(255) NOT NULL,
          password VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log("Table 'users' created successfully");

      return db;
    } catch (error) {
      console.error("Failed to connect to the database, retrying...", error);
      retries -= 1;
      await new Promise(res => setTimeout(res, delay));
    }
  }
  throw new Error("Could not connect to the database after multiple attempts");
};

connectToDatabase().then(db => {
  app.use(express.json());

  app.get("/", (req, res) => {
    res.json("user service");
  });

 // Register a new user
 app.post("/register", async (req, res) => {
    const { username, password } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.none("INSERT INTO users(username, password) VALUES($1, $2)", [username, hashedPassword]);
      res.status(201).json({ message: "User registered successfully" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Login a user
  app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    try {
      const user = await db.oneOrNone("SELECT * FROM users WHERE username = $1", [username]);
      if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.status(200).json({ message: "Login successful", token });
      } else {
        res.status(401).json({ message: "Invalid username or password" });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Read all users
  app.get("/all", (req, res) => {
    db.any("SELECT * FROM users")
      .then((data) => {
        res.status(200).json(data);
      })
      .catch((error) => {
        res.status(500).json({ error: error.message });
      });
  });

  // Update a user
  app.put("/user/:id", (req, res) => {
    const { id } = req.params;
    const { username, password } = req.body;
    db.none("UPDATE users SET username=$1, password=$2 WHERE id=$3", [username, password, id])
      .then(() => {
        res.status(200).json({ message: "User updated successfully" });
      })
      .catch((error) => {
        res.status(500).json({ error: error.message });
      });
  });

  // Delete a user
  app.delete("/user/:id", (req, res) => {
    const { id } = req.params;
    db.none("DELETE FROM users WHERE id=$1", [id])
      .then(() => {
        res.status(204).json({ message: "User deleted successfully" });
      })
      .catch((error) => {
        res.status(500).json({ error: error.message });
      });
  });

  // Get all users
  app.get("/users", (req, res) => {
    db.any("SELECT * FROM users")
      .then((data) => {
        res.status(200).json(data);
      })
      .catch((error) => {
        res.status(500).json({ error: error.message });
      });
  });

  app.listen(process.env.PORT, () => {
    console.log(
      `Example app listening at ${process.env.APP_URL}:${process.env.PORT}`
    );
  });
}).catch(error => {
  console.error("Failed to start the server:", error);
});