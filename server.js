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
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

// Trust proxy - CRITICAL for Koyeb deployment
app.set('trust proxy', 1); // Trust first proxy (Koyeb load balancer)

// Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestIp.mw());

// Rate limiting - TEMPORARILY DISABLED to fix proxy issues
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
//   legacyHeaders: false, // Disable the `X-RateLimit-*` headers
//   trustProxy: true, // Trust proxy headers
//   skip: (req) => {
//     // Skip rate limiting for health checks
//     return req.path === '/health';
//   }
// });
// app.use(limiter);

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Enhanced User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String }, // Optional for OAuth users
  name: { type: String, required: true },
  username: { type: String, unique: true, sparse: true },
  age: { type: Number },
  birthday: { type: Date },
  gender: { type: String, enum: ['male', 'female', 'other'] },
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
  profilePicture: String,
  coverPhoto: String,
  profileImages: [String],
  bio: String,
  interests: [String],
  favoriteAnimal: String,
  
  // Social media links
  instagram: String,
  facebook: String,
  twitter: String,
  
  // Account status
  isSubscribed: { type: Boolean, default: false },
  isVerified: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  
  // ID Verification
  idVerificationStatus: { 
    type: String, 
    enum: ['not_submitted', 'pending', 'approved', 'rejected'], 
    default: 'not_submitted' 
  },
  idVerificationUploadedAt: Date,
  idVerificationRejectionReason: String,
  
  // OAuth info
  googleId: String,
  
  // Points and badges
  points: { type: Number, default: 0 },
  badges: [String],
  
  // Matching data
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

// Helper function to generate JWT token
const generateToken = (userId, email) => {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// ==================== AUTHENTICATION ROUTES ====================

// Google OAuth authentication
app.post('/api/auth/google', async (req, res) => {
  try {
    console.log('🔍 Google OAuth request received');
    console.log('📦 Request body:', req.body);
    
    const { credential } = req.body;
    
    if (!credential) {
      console.error('❌ No credential provided in request');
      return res.status(400).json({ 
        success: false, 
        message: 'Google credential is required' 
      });
    }

    console.log('🔑 Google credential received, length:', credential.length);
    console.log('🔧 Google Client ID:', process.env.GOOGLE_CLIENT_ID ? 'Set' : 'NOT SET');
    
    // Verify the Google token
    console.log('🔄 Attempting to verify Google token...');
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    console.log('✅ Google token verified successfully');
    const payload = ticket.getPayload();
    console.log('📋 Token payload:', {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture ? 'Present' : 'Not present'
    });
    
    const { sub: googleId, email, name, picture } = payload;

    if (!email || !name) {
      console.error('❌ Invalid Google account data - missing email or name');
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid Google account data' 
      });
    }

    console.log('🔍 Searching for existing user with email:', email);
    
    // Check if user already exists
    let user = await User.findOne({ 
      $or: [{ email }, { googleId }] 
    });

    if (user) {
      console.log('👤 Found existing user:', user._id);
      console.log('📍 Existing user location:', user.location);
      
      // Update existing user
      user.googleId = googleId;
      user.lastActive = new Date();
      if (picture && !user.profilePicture) {
        user.profilePicture = picture;
      }
      
      // CRITICAL FIX: Ensure user has valid location coordinates
      if (!user.location || !user.location.coordinates || user.location.coordinates.length !== 2) {
        console.log('🔧 User missing valid coordinates, adding default location...');
        const defaultLocation = await getLocationFromIP('8.8.8.8');
        user.location = {
          type: 'Point',
          coordinates: defaultLocation.coordinates,
          address: defaultLocation.address,
          city: defaultLocation.city,
          state: defaultLocation.state,
          country: defaultLocation.country
        };
        console.log('✅ Added default location to existing user');
      }
      
      await user.save();
      console.log('✅ Updated existing user');
    } else {
      console.log('👤 Creating new user...');
      // Create new user with default location
      const defaultLocation = await getLocationFromIP('8.8.8.8'); // Default to fallback location
      
      user = new User({
        email,
        name,
        googleId,
        profilePicture: picture,
        location: {
          type: 'Point',
          coordinates: defaultLocation.coordinates,
          address: defaultLocation.address,
          city: defaultLocation.city,
          state: defaultLocation.state,
          country: defaultLocation.country
        },
        points: 50, // Welcome bonus
        lastActive: new Date()
      });
      
      await user.save();
      console.log('✅ Created new user:', user._id);
    }

    console.log('🔐 Generating JWT token...');
    console.log('🔧 JWT Secret:', process.env.JWT_SECRET ? 'Set' : 'NOT SET');
    
    // Generate JWT token
    const token = generateToken(user._id, user.email);
    console.log('✅ JWT token generated, length:', token.length);

    const responseData = {
      success: true,
      message: 'Authentication successful',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        profilePicture: user.profilePicture,
        isSubscribed: user.isSubscribed,
        points: user.points
      }
    };
    
    console.log('📤 Sending success response:', {
      success: responseData.success,
      message: responseData.message,
      userEmail: responseData.user.email,
      userName: responseData.user.name
    });

    res.json(responseData);

  } catch (error) {
    console.error('💥 Google OAuth error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    
    if (error.message && error.message.includes('Token used too early')) {
      console.error('⏰ Token timing issue - this is a Google OAuth timing problem');
    } else if (error.message && error.message.includes('Wrong audience')) {
      console.error('🎯 Wrong audience - check GOOGLE_CLIENT_ID configuration');
    } else if (error.message && error.message.includes('Invalid token signature')) {
      console.error('🔏 Invalid token signature - token may be corrupted');
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Authentication failed' 
    });
  }
});

// ==================== PROFILE ROUTES ====================

// Get user profile
app.get('/api/profile/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        username: user.username,
        age: user.age,
        birthday: user.birthday,
        gender: user.gender,
        bio: user.bio,
        profilePicture: user.profilePicture,
        coverPhoto: user.coverPhoto,
        location: user.location?.address,
        interests: user.interests,
        favoriteAnimal: user.favoriteAnimal,
        instagram: user.instagram,
        facebook: user.facebook,
        twitter: user.twitter,
        isSubscribed: user.isSubscribed,
        isVerified: user.isVerified,
        points: user.points,
        badges: user.badges,
        petCount: user.pets?.length || 0,
        idVerificationStatus: user.idVerificationStatus,
        idVerificationUploadedAt: user.idVerificationUploadedAt,
        idVerificationRejectionReason: user.idVerificationRejectionReason,
        createdAt: user.createdAt,
        lastActive: user.lastActive
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get profile' 
    });
  }
});

// Update user profile
app.put('/api/profile/update', authenticateToken, upload.single('profilePicture'), async (req, res) => {
  try {
    const userId = req.user.userId;
    const updateData = {};

    // Handle text fields
    const allowedFields = [
      'name', 'username', 'age', 'birthday', 'gender', 'bio', 
      'interests', 'favoriteAnimal', 'instagram', 'facebook', 'twitter'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    // Handle interests array
    if (req.body.interests) {
      if (typeof req.body.interests === 'string') {
        updateData.interests = req.body.interests.split(',').map(i => i.trim());
      } else if (Array.isArray(req.body.interests)) {
        updateData.interests = req.body.interests;
      }
    }

    // Handle file upload
    if (req.file) {
      // For now, we'll store as base64 - in production, use cloud storage
      const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      updateData.profilePicture = base64Image;
    }

    // Update last active
    updateData.lastActive = new Date();

    const user = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, select: '-password' }
    );

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        name: user.name,
        profilePicture: user.profilePicture,
        bio: user.bio,
        interests: user.interests
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({ 
        success: false, 
        message: 'Username already taken' 
      });
    }

    res.status(500).json({ 
      success: false, 
      message: 'Failed to update profile' 
    });
  }
});

// Upload cover photo
app.put('/api/profile/cover-photo', authenticateToken, upload.single('coverPhoto'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cover photo file is required' 
      });
    }

    // Convert to base64 for storage
    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { 
        coverPhoto: base64Image,
        lastActive: new Date()
      },
      { new: true, select: 'coverPhoto' }
    );

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      message: 'Cover photo updated successfully',
      coverPhoto: user.coverPhoto
    });

  } catch (error) {
    console.error('Cover photo upload error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update cover photo' 
    });
  }
});

// Submit ID verification
app.post('/api/profile/submit-id-verification', authenticateToken, upload.array('idDocuments', 2), async (req, res) => {
  try {
    if (!req.files || req.files.length !== 2) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please upload both front and back of your ID' 
      });
    }

    // In production, upload files to cloud storage and store URLs
    // For now, we'll just update the verification status
    
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      {
        idVerificationStatus: 'pending',
        idVerificationUploadedAt: new Date(),
        idVerificationRejectionReason: null,
        lastActive: new Date()
      },
      { new: true, select: 'idVerificationStatus idVerificationUploadedAt' }
    );

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({
      success: true,
      message: 'ID verification submitted successfully',
      idVerificationStatus: user.idVerificationStatus,
      submittedAt: user.idVerificationUploadedAt
    });

  } catch (error) {
    console.error('ID verification submission error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to submit ID verification' 
    });
  }
});

// ==================== EXISTING ROUTES ====================

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
  console.log('🚀 PeThoria Server with Authentication ready!');
  console.log('📱 Google OAuth integration enabled');
  console.log('🌍 Location-based matching system ready!');
}); 
