const express = require('express');
const cors = require('cors');
require('dotenv').config()
const port = process.env.POST || 5000;
const app = express();
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require("stripe")(process.env.STRIPE_KEY)


app.use(cors());
app.use(express.json());



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ru2hz6y.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send('unauthorized access')
  }
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: 'forbidden access' })
    }
    req.decoded = decoded;
    next();
  })

}

async function run() {
  try {
    const appointmentOptionCollection = client.db('doctorsPortals').collection('appointmentData');
    const bookingsCollection = client.db('doctorsPortals').collection('bookingCollection');
    const usersCollection = client.db('doctorsPortals').collection('users');
    const doctorsCollection = client.db('doctorsPortals').collection('doctors');
    const paymentsCollection = client.db('doctorsPortals').collection('payments');

    // verifyAdmin system
    const verifyAdmin = async (req, res, next) => {
      console.log('inside verifyAdmin', req.decoded.email);
      const decodeEmail = req.decoded.email;
      const query = { email: decodeEmail };
      const user = await usersCollection.findOne(query);

      if (user?.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' })
      }
      next();
    }



    app.get('/appointmentOptions', async (req, res) => {
      const date = req.query.date;
      const query = {};
      const options = await appointmentOptionCollection.find(query).toArray();

      //  get a booking date  
      const bookingQuery = { appointmentData: date }
      const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

      options.forEach(option => {
        const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
        const bookedSlots = optionBooked.map(book => book.slot);
        const remainSlot = option.slots.filter(slot => !bookedSlots.includes(slot));
        option.slots = remainSlot;
      })
      res.send(options)
    })

    app.get('/bookings', verifyJWT, async (req, res) => {
      const email = req.query.email;
      const decodeEmail = req.decoded.email;
      if (email !== decodeEmail) {
        return res.status(403).send({ message: 'forbidden access' })
      }

      const query = { email: email };
      const booking = await bookingsCollection.find(query).toArray();
      res.send(booking);
    })

    app.post('/bookings', async (req, res) => {
      const booking = req.body;
      const query = {
        appointmentData: booking.appointmentData,
        treatment: booking.treatment,
        email: booking.email
      }

      const alreadyBooked = await bookingsCollection.find(query).toArray();
      if (alreadyBooked.length) {
        const message = `You already have a booking on ${booking.appointmentData}`
        return res.send({ acKnowLedged: false, message })
      }

      const result = await bookingsCollection.insertOne(booking)
      res.send(result)
    });

    app.get('/bookings/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: ObjectId(id) }
      const result = await bookingsCollection.findOne(query)
      res.send(result)
    })

    app.get('/jwt', async (req, res) => {
      const email = req.query.email;
      const query = { email: email }
      const user = await usersCollection.findOne(query)
      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '10h' })
        return res.send({ accessToken: token })

      }
      res.status(403).send({ accessToken: '' })

    })

    app.get('/users', async (req, res) => {
      const query = {}
      const result = await usersCollection.find(query).toArray()
      res.send(result)
    })

    app.post('/users', async (req, res) => {
      const user = req.body;
      const result = await usersCollection.insertOne(user)
      res.send(result);

    })

    app.get('/users/admin/:email', async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ isAdmin: user?.role === 'admin' });

    })

    app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {


      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const option = { upsert: true };
      const updateDoc = {
        $set: {
          role: 'admin'
        }
      }
      const result = await usersCollection.updateOne(filter, updateDoc, option);
      res.send(result);
    })

    app.get('/appointmentSpecialty', async (req, res) => {
      const query = {}
      const result = await appointmentOptionCollection.find(query).project({ name: 1 }).toArray()
      res.send(result)
    })

    app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
      const user = req.params.data;
      const query = { user };
      const result = await doctorsCollection.find(query).toArray();
      res.send(result);
    });

    app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
      const user = req.body;
      const result = await doctorsCollection.insertOne(user);
      res.send(result);
    });

    app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: ObjectId(id) }
      const result = await doctorsCollection.deleteOne(filter)
      res.send(result)
    });

    // payment setup ---

    app.post("/create-payment-intent", async (req, res) => {
      const booking = req.body;
      const price = booking.price;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        currency: 'usd',
        amount: amount,
        "payment_method_types": [
          "card"
        ]
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      })
    });


    // payment info save data system

    app.post('/payments', async (req, res) => {
      const payment = req.body;
      console.log(payment);
      const result = await paymentsCollection.insertOne(payment);
      const id = payment.bookingId;
      const filter = { _id: ObjectId(id) }
      const updateDoc = {
        $set: {
          paid: true,
          transactionId: payment.transactionId
        }
      }
      const updateResult = await bookingsCollection.updateOne(filter, updateDoc)
      console.log(updateResult);
      res.send(updateResult);
    })

  }

  finally {

  }

}
run().catch(err => console.log(err))


app.get('/', (req, res) => {
  res.send('doctors portal server  is running');
})

app.listen(port, () => console.log(`Doctors portal running 0n ${port}`))