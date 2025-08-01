const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const requestIp = require('request-ip');
const axios = require('axios');
const geolib = require('geolib');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestIp.mw());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  age: { type: Number, required: true },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }, // [longitude, latitude]
    address: { type: String },
    city: { type: String },
    state: { type: String },
    country: { type: String }
  },
  preferences: {
    ageRange: { min: Number, max: Number },
    distance: { type: Number, default: 10 }, // in miles
    petType: { type: String, enum: ['dog', 'cat', 'bird', 'fish', 'other'], default: 'dog' }
  },
  pets: [{
    name: String,
    type: String,
    breed: String,
    age: Number,
    description: String,
    images: [String],
    isActive: { type: Boolean, default: true }
  }],
  profileImages: [String],
  bio: String,
  isSubscribed: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  swipedProfiles: [{
    profileId: mongoose.Schema.Types.ObjectId,
    action: { type: String, enum: ['like', 'pass', 'superlike'] },
    timestamp: { type: Date, default: Date.now }
  }],
  matches: [{
    matchedUserId: mongoose.Schema.Types.ObjectId,
    timestamp: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true }
  }]
}, {
  timestamps: true
});

// Create geospatial index for location-based queries
userSchema.index({ location: '2dsphere' });

const User = mongoose.model('User', userSchema);

// IP Geolocation service
async function getLocationFromIP(ip) {
  try {
    // Using ipapi.co (free tier available)
    const response = await axios.get(`http://ipapi.co/${ip}/json/`);
    const data = response.data;
    
    if (data.latitude && data.longitude) {
      return {
        coordinates: [data.longitude, data.latitude],
        address: `${data.city}, ${data.region}`,
        city: data.city,
        state: data.region,
        country: data.country_name
      };
    }
  } catch (error) {
    console.error('IP geolocation error:', error);
  }
  
  // Fallback to default location (Seattle, WA)
  return {
    coordinates: [-122.3321, 47.6062],
    address: 'Seattle, WA',
    city: 'Seattle',
    state: 'WA',
    country: 'United States'
  };
}

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Routes

// Get user's location from IP
app.get('/api/location/ip', async (req, res) => {
  try {
    const clientIp = req.clientIp;
    const location = await getLocationFromIP(clientIp);
    
    res.json({
      success: true,
      location: location,
      ip: clientIp
    });
  } catch (error) {
    console.error('Location from IP error:', error);
    res.status(500).json({ error: 'Failed to get location from IP' });
  }
});

// Update user location
app.post('/api/location/update', authenticateToken, async (req, res) => {
  try {
    const { latitude, longitude, address, city, state, country } = req.body;
    
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }
    
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      {
        location: {
          type: 'Point',
          coordinates: [longitude, latitude],
          address: address || '',
          city: city || '',
          state: state || '',
          country: country || ''
        }
      },
      { new: true }
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      success: true,
      location: user.location
    });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Get nearby profiles for matching
app.get('/api/matches/nearby', authenticateToken, async (req, res) => {
  try {
    const { type = 'pets', distance = 10, limit = 20 } = req.query;
    const currentUser = await User.findById(req.user.userId);
    
    if (!currentUser || !currentUser.location) {
      return res.status(400).json({ error: 'User location not set' });
    }
    
    // Get user's swiped profiles to exclude them
    const swipedProfileIds = currentUser.swipedProfiles.map(profile => profile.profileId);
    
    // Convert miles to meters for MongoDB query
    const distanceInMeters = distance * 1609.34;
    
    // Find nearby users
    const nearbyUsers = await User.find({
      _id: { 
        $ne: currentUser._id,
        $nin: swipedProfileIds
      },
      location: {
        $near: {
          $geometry: currentUser.location,
          $maxDistance: distanceInMeters
        }
      },
      lastActive: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Active in last 30 days
    }).limit(parseInt(limit));
    
    // Format profiles for frontend
    const profiles = nearbyUsers.map(user => {
      // Calculate distance
      const distance = geolib.getDistance(
        { latitude: currentUser.location.coordinates[1], longitude: currentUser.location.coordinates[0] },
        { latitude: user.location.coordinates[1], longitude: user.location.coordinates[0] }
      );
      
      const distanceInMiles = (distance * 0.000621371).toFixed(1);
      
      if (type === 'pets' && user.pets.length > 0) {
        // Return pet profiles
        return user.pets.filter(pet => pet.isActive).map(pet => ({
          id: `${user._id}_${pet._id}`,
          userId: user._id,
          name: pet.name,
          age: pet.age,
          type: pet.type,
          breed: pet.breed,
          bio: pet.description,
          images: pet.images,
          location: `${distanceInMiles} miles away`,
          ownerName: user.name,
          isVerified: user.isSubscribed,
          hasSubscription: user.isSubscribed
        }));
      } else {
        // Return owner profiles
        return {
          id: user._id,
          userId: user._id,
          name: user.name,
          age: user.age,
          bio: user.bio,
          images: user.profileImages,
          location: `${distanceInMiles} miles away`,
          petCount: user.pets.length,
          isVerified: user.isSubscribed,
          hasSubscription: user.isSubscribed
        };
      }
    }).flat().filter(Boolean);
    
    res.json({
      success: true,
      profiles: profiles,
      total: profiles.length
    });
  } catch (error) {
    console.error('Get nearby profiles error:', error);
    res.status(500).json({ error: 'Failed to get nearby profiles' });
  }
});

// Record swipe action
app.post('/api/matches/swipe', authenticateToken, async (req, res) => {
  try {
    const { profileId, action } = req.body;
    
    if (!profileId || !['like', 'pass', 'superlike'].includes(action)) {
      return res.status(400).json({ error: 'Invalid profile ID or action' });
    }
    
    const currentUser = await User.findById(req.user.userId);
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Add swipe to user's history
    currentUser.swipedProfiles.push({
      profileId: profileId,
      action: action,
      timestamp: new Date()
    });
    
    let isMatch = false;
    
    // Check for match if it's a like or superlike
    if (action === 'like' || action === 'superlike') {
      const targetUserId = profileId.includes('_') ? profileId.split('_')[0] : profileId;
      const targetUser = await User.findById(targetUserId);
      
      if (targetUser) {
        // Check if target user has already liked current user
        const mutualLike = targetUser.swipedProfiles.find(
          swipe => swipe.profileId.toString() === currentUser._id.toString() && 
          (swipe.action === 'like' || swipe.action === 'superlike')
        );
        
        if (mutualLike) {
          // It's a match!
          isMatch = true;
          
          // Add match to both users
          currentUser.matches.push({
            matchedUserId: targetUserId,
            timestamp: new Date()
          });
          
          targetUser.matches.push({
            matchedUserId: currentUser._id,
            timestamp: new Date()
          });
          
          await targetUser.save();
        }
      }
    }
    
    await currentUser.save();
    
    res.json({
      success: true,
      isMatch: isMatch,
      action: action
    });
  } catch (error) {
    console.error('Swipe action error:', error);
    res.status(500).json({ error: 'Failed to record swipe action' });
  }
});

// Get user's matches
app.get('/api/matches', authenticateToken, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.userId).populate('matches.matchedUserId');
    
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const matches = currentUser.matches
      .filter(match => match.isActive)
      .map(match => ({
        id: match.matchedUserId._id,
        name: match.matchedUserId.name,
        image: match.matchedUserId.profileImages[0] || '',
        timestamp: match.timestamp,
        lastMessage: null // TODO: Add last message from chat system
      }));
    
    res.json({
      success: true,
      matches: matches
    });
  } catch (error) {
    console.error('Get matches error:', error);
    res.status(500).json({ error: 'Failed to get matches' });
  }
});

// Update user preferences
app.post('/api/preferences/update', authenticateToken, async (req, res) => {
  try {
    const { distance, ageRange, petType } = req.body;
    
    const updateData = {};
    if (distance) updateData['preferences.distance'] = distance;
    if (ageRange) updateData['preferences.ageRange'] = ageRange;
    if (petType) updateData['preferences.petType'] = petType;
    
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      updateData,
      { new: true }
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      success: true,
      preferences: user.preferences
    });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`MongoDB connected: ${mongoose.connection.readyState === 1 ? 'Yes' : 'No'}`);
  console.log('🌍 Location-based matching system ready!');
}); 
