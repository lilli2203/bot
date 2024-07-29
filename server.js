const express = require('express');
const OpenAI = require('openai');
const { Sequelize, DataTypes } = require('sequelize');
const axios = require('axios');
require('dotenv').config();
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');

const app = express();
app.use(express.json());
app.use(cors());
app.use(morgan('combined'));
app.use(express.static(path.join(__dirname, 'public')));

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY
});

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: process.env.DATABASE_STORAGE_PATH || './database.sqlite'
});

const User = sequelize.define('User', {
  userId: {
    type: DataTypes.STRING,
    primaryKey: true
  },
  fullName: DataTypes.STRING,
  email: DataTypes.STRING,
  lastInteraction: DataTypes.DATE
});

const Conversation = sequelize.define('Conversation', {
  userId: DataTypes.STRING,
  messages: DataTypes.TEXT
});

const Booking = sequelize.define('Booking', {
  bookingId: {
    type: DataTypes.STRING,
    primaryKey: true
  },
  userId: DataTypes.STRING,
  roomId: DataTypes.INTEGER,
  checkInDate: DataTypes.DATE,
  checkOutDate: DataTypes.DATE,
  totalAmount: DataTypes.FLOAT,
  isPaid: DataTypes.BOOLEAN
});

const Review = sequelize.define('Review', {
  reviewId: {
    type: DataTypes.STRING,
    primaryKey: true
  },
  bookingId: DataTypes.STRING,
  userId: DataTypes.STRING,
  rating: DataTypes.INTEGER,
  comment: DataTypes.TEXT
});

sequelize.sync().then(() => {
  console.log('Database synchronized');
}).catch(error => {
  console.error('Error synchronizing database:', error);
});

function authenticateUser(req, res, next) {
  const { userId } = req.body;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleString()}] ${req.method} ${req.url}`);
  next();
});

app.post('/register', async (req, res) => {
  const { userId, fullName, email } = req.body;
  try {
    const user = await User.create({ userId, fullName, email, lastInteraction: new Date() });
    res.json(user);
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ error: 'Error registering user' });
  }
});

app.get('/conversations/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const conversations = await Conversation.findAll({ where: { userId } });
    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Error fetching conversations' });
  }
});

app.post('/book', async (req, res) => {
  const { roomId, fullName, email, nights } = req.body;
  try {
    const response = await axios.post('https://bot9assignement.deno.dev/book', {
      roomId,
      fullName,
      email,
      nights
    });

    const checkInDate = new Date();
    const checkOutDate = new Date(checkInDate);
    checkOutDate.setDate(checkOutDate.getDate() + nights);

    await Booking.create({
      bookingId: response.data.bookingId,
      userId: email,
      roomId: roomId,
      checkInDate: checkInDate,
      checkOutDate: checkOutDate,
      totalAmount: response.data.totalPrice,
      isPaid: false
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error booking room:', error);
    res.status(500).json({ error: 'Error booking room' });
  }
});

app.post('/process-payment', async (req, res) => {
  const { bookingId, amount, method } = req.body;
  try {
    const paymentResult = await processPayment(bookingId, amount, method);
    res.json(paymentResult);
  } catch (error) {
    console.error('Error processing payment:', error);
    res.status(500).json({ error: 'Error processing payment' });
  }
});

app.post('/chat', authenticateUser, async (req, res) => {
  const { message, userId } = req.body;

  let user = await User.findOne({ where: { userId } });
  if (!user) {
    user = await User.create({ userId, lastInteraction: new Date() });
  } else {
    await user.update({ lastInteraction: new Date() });
  }

  let conversation = await Conversation.findOne({ where: { userId } });
  if (!conversation) {
    conversation = await Conversation.create({ userId, messages: '[]' });
  }

  let messages = JSON.parse(conversation.messages);
  messages.push({ role: 'user', content: message });

  const systemMessage = `
    You are a polite and helpful hotel booking assistant chatbot. Always maintain a friendly and professional tone.
    Key points:
    1. If asked "Who are you?", explain that you're a hotel booking assistant chatbot.
    2. If asked "Who am I?", provide details about the user if available.
    3. If faced with inappropriate language or queries, respond ethically and professionally, redirecting the conversation to booking-related topics.
    4. Guide users through the booking process: greeting, showing rooms, asking for nights of stay, calculating price, confirming booking, and processing payment.
    5. When a booking is confirmed, always provide the booking ID returned by the booking system to the user.
    6. Ask for payment after a booking is confirmed. Use the process_payment function to process payments.
    7. Provide check-in and check-out dates when asked or after a successful booking.
    8. You can communicate in any language the user prefers.
    User details: ${JSON.stringify(user)}
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemMessage },
        ...messages
      ],
      functions: [
        {
          name: "get_rooms",
          description: "Get available hotel rooms",
          parameters: { type: "object", properties: {} }
        },
        {
          name: "book_room",
          description: "Book a hotel room",
          parameters: {
            type: "object",
            properties: {
              roomId: { type: "number" },
              fullName: { type: "string" },
              email: { type: "string" },
              nights: { type: "number" }
            },
            required: ["roomId", "fullName", "email", "nights"]
          }
        },
        {
          name: "process_payment",
          description: "Process payment for a booking",
          parameters: {
            type: "object",
            properties: {
              bookingId: { type: "string" },
              amount: { type: "number" },
              method: { type: "string", enum: ["credit_card", "debit_card", "paypal"] }
            },
            required: ["bookingId", "amount", "method"]
          }
        }
      ],
      function_call: "auto",
    });

    const assistantMessage = completion.data.choices[0].message.content;
    messages.push({ role: 'system', content: assistantMessage });

    await conversation.update({ messages: JSON.stringify(messages) });

    res.json({ messages });
  } catch (error) {
    console.error('Error processing chat:', error);
    res.status(500).json({ error: 'Error processing chat' });
  }
});

app.get('/users', async (req, res) => {
  try {
    const users = await User.findAll();
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Error fetching users' });
  }
});

app.get('/bookings/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const bookings = await Booking.findAll({ where: { userId } });
    res.json(bookings);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'Error fetching bookings' });
  }
});

app.put('/update-user/:userId', async (req, res) => {
  const { userId } = req.params;
  const { fullName, email } = req.body;
  try {
    await User.update({ fullName, email }, { where: { userId } });
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Error updating user' });
  }
});

app.post('/add-review', authenticateUser, async (req, res) => {
  const { bookingId, userId, rating, comment } = req.body;
  try {
    const review = await Review.create({
      reviewId: Math.random().toString(36).substr(2, 9).toUpperCase(),
      bookingId,
      userId,
      rating,
      comment
    });
    res.json(review);
  } catch (error) {
    console.error('Error adding review:', error);
    res.status(500).json({ error: 'Error adding review' });
  }
});

app.get('/reviews/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  try {
    const reviews = await Review.findAll({ where: { bookingId } });
    res.json(reviews);
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ error: 'Error fetching reviews' });
  }
});

async function processPayment(bookingId, amount, method) {
  try {
    const gatewayResponse = await new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          success: Math.random() < 0.9, 
          transactionId: Math.random().toString(36).substr(2, 9).toUpperCase(),
          message: 'Payment processed successfully'
        });
      }, 1000); 
    });

    if (gatewayResponse.success) {
      await Booking.update({ isPaid: true }, { where: { bookingId: bookingId } });
      return { 
        status: 'success', 
        message: `Payment of $${amount} processed via ${method}. Transaction ID: ${gatewayResponse.transactionId}` 
      };
    } else {
      return { 
        status: 'failed', 
        message: 'Payment processing failed. Please try again.' 
      };
    }
  } catch (error) {
    console.error('Error processing payment:', error);
    return { status: 'failed', message: 'An error occurred while processing the payment.' };
  }
}

async function getRooms() {
  try {
    const response = await axios.get('https://bot9assignement.deno.dev/rooms');
    return response.data;
  } catch (error) {
    console.error('Error fetching rooms:', error);
    return [];
  }
}

pp.put('/update-booking/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const { roomId, checkInDate, checkOutDate } = req.body;
  try {
    const booking = await Booking.findOne({ where: { bookingId } });
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    await booking.update({ roomId, checkInDate, checkOutDate });
    res.json({ message: 'Booking updated successfully', booking });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({ error: 'Error updating booking' });
  }
});

app.delete('/delete-booking/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  try {
    const booking = await Booking.findOne({ where: { bookingId } });
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    await booking.destroy();
    res.json({ message: 'Booking deleted successfully' });
  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).json({ error: 'Error deleting booking' });
  }
});

app.get('/reviews-by-user/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const reviews = await Review.findAll({ where: { userId } });
    res.json(reviews);
  } catch (error) {
    console.error('Error fetching reviews by user:', error);
    res.status(500).json({ error: 'Error fetching reviews by user' });
  }
});

// Endpoint to fetch all bookings within a date range
app.get('/bookings-in-range', async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const bookings = await Booking.findAll({
      where: {
        checkInDate: { [Op.between]: [new Date(startDate), new Date(endDate)] }
      }
    });
    res.json(bookings);
  } catch (error) {
    console.error('Error fetching bookings within range:', error);
    res.status(500).json({ error: 'Error fetching bookings within range' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
