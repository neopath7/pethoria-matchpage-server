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
const paypal = require('paypal-rest-sdk');
const { Client, Environment } = require('square');
const redis = require('redis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

// Graceful shutdown handler
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (redisClient) {
    redisClient.quit();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  if (redisClient) {
    redisClient.quit();
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.log('App will continue running...');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  console.log('App will continue running...');
});

// Initialize Redis client
let redisClient;
if (process.env.REDIS_URL) {
  try {
    console.log('🔗 Attempting Redis connection to:', process.env.REDIS_URL.replace(/:[^:@]*@/, ':****@'));
    
    redisClient = redis.createClient({
      url: process.env.REDIS_URL,
      socket: {
        connectTimeout: 10000, // 10 seconds
        lazyConnect: true,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.log('❌ Redis max reconnection attempts reached');
            return false;
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });

    // Handle Redis events
    redisClient.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
      redisClient = null;
    });

    redisClient.on('connect', () => {
      console.log('🔗 Redis connecting...');
    });

    redisClient.on('ready', () => {
      console.log('✅ Redis connected successfully');
    });

    redisClient.on('end', () => {
      console.log('🔌 Redis connection ended');
      redisClient = null;
    });

    // Attempt connection
    redisClient.connect().then(() => {
      console.log('✅ Redis connection established');
    }).catch((error) => {
      console.error('❌ Redis connection failed:', error.message);
      console.log('⚠️ Using memory cache fallback');
      redisClient = null;
    });
  } catch (error) {
    console.error('❌ Redis initialization failed:', error.message);
    console.log('⚠️ Using memory cache fallback');
    redisClient = null;
  }
} else {
  console.log('ℹ️ No Redis URL provided, using memory cache fallback');
  redisClient = null;
}

// Redis caching utilities
const cacheUtils = {
  // Set cache with TTL (Time To Live)
  async set(key, value, ttl = 300) { // Default 5 minutes
    if (!redisClient) return false;
    try {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      console.log('Redis set error:', error.message);
      return false;
    }
  },

  // Get cache
  async get(key) {
    if (!redisClient) return null;
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.log('Redis get error:', error.message);
      return null;
    }
  },

  // Delete cache
  async del(key) {
    if (!redisClient) return false;
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.log('Redis del error:', error.message);
      return false;
    }
  },

  // Clear user cache
  async clearUserCache(userId) {
    if (!redisClient) return false;
    try {
      const keys = await redisClient.keys(`user:${userId}:*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
      return true;
    } catch (error) {
      console.log('Redis clear user cache error:', error.message);
      return false;
    }
  }
};

// Trust proxy - CRITICAL for Koyeb deployment
app.set('trust proxy', 1); // Trust first proxy (Koyeb load balancer)

// Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Initialize PayPal
paypal.configure({
  'mode': process.env.NODE_ENV === 'production' ? 'live' : 'sandbox',
  'client_id': process.env.PAYPAL_CLIENT_ID,
  'client_secret': process.env.PAYPAL_CLIENT_SECRET
});

// Initialize Square client
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.NODE_ENV === 'production' ? Environment.Production : Environment.Sandbox
});

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

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    redis: redisClient ? 'connected' : 'not connected',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'not connected'
  });
});

// Redis test endpoint
app.get('/api/redis/test', async (req, res) => {
  try {
    if (!redisClient) {
      return res.status(503).json({
        status: 'error',
        message: 'Redis not available',
        redis: 'not connected',
        reason: 'Redis client not initialized'
      });
    }

    // Test Redis operations
    const testKey = 'test:redis:connection';
    const testData = { message: 'Hello Redis!', timestamp: new Date().toISOString() };
    
    // Test set
    const setResult = await cacheUtils.set(testKey, testData, 60);
    if (!setResult) {
      throw new Error('Failed to set cache');
    }

    // Test get
    const getResult = await cacheUtils.get(testKey);
    if (!getResult) {
      throw new Error('Failed to get cache');
    }

    // Test delete
    const delResult = await cacheUtils.del(testKey);
    if (!delResult) {
      throw new Error('Failed to delete cache');
    }

    res.json({
      status: 'success',
      message: 'Redis is working correctly!',
      redis: 'connected',
      tests: {
        set: 'passed',
        get: 'passed',
        delete: 'passed'
      },
      data: testData
    });

  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Redis test failed',
      error: error.message,
      redis: redisClient ? 'connected' : 'not connected',
      details: {
        hasRedisClient: !!redisClient,
        redisUrl: process.env.REDIS_URL ? 'configured' : 'not configured',
        environment: process.env.NODE_ENV || 'development'
      }
    });
  }
});

// Redis status endpoint
app.get('/api/redis/status', (req, res) => {
  res.json({
    status: 'success',
    redis: {
      connected: redisClient ? true : false,
      url: process.env.REDIS_URL ? 'configured' : 'not configured',
      environment: process.env.NODE_ENV || 'development'
    },
    cache: {
      enabled: redisClient ? true : false,
      ttl: '5 minutes (300 seconds)',
      features: [
        'User profile caching',
        'Cache invalidation on updates',
        'Automatic fallback to database'
      ]
    }
  });
});

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
//     //   }
//   }
// });
// app.use(limiter);

// MongoDB connection
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected successfully'))
    .catch(err => {
      console.error('❌ MongoDB connection error:', err);
      console.log('⚠️ App will continue without database connection');
    });
} else {
  console.log('ℹ️ No MongoDB URI provided, app will run without database');
}

// Enhanced User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String }, // Optional for OAuth users
  name: { type: String, required: true },
  username: { type: String, unique: true, sparse: true, default: null },
  age: { type: Number },
  birthday: { type: Date },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    // Not required at signup; user can set later from match filters or profile
    coordinates: { type: [Number], required: false }, // [longitude, latitude]
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
  
  // User statistics for dashboard
  totalMatches: { type: Number, default: 0 },
  messagesCount: { type: Number, default: 0 },
  profileViews: { type: Number, default: 0 },

  // User activity tracking
    recentActivity: [{
    type: {
      type: String,
      enum: ['match', 'message', 'points_earned', 'profile_updated', 'verification_completed', 'verification_submitted', 'membership', 'login', 'pet_added', 'swipe_like', 'swipe_pass'],
      required: true
    },
    description: { type: String, required: true },
    relatedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    relatedUserName: String,
    pointsEarned: Number,
    timestamp: { type: Date, default: Date.now }
  }],
  
  // Membership fields
  membershipType: { type: String, enum: ['free', 'premium'], default: 'free' },
  membershipStatus: { type: String, enum: ['active', 'cancelled', 'expired'], default: 'active' },
  membershipPlan: { type: String, enum: ['monthly', 'yearly', 'lifetime'] },
  membershipStartDate: Date,
  membershipEndDate: Date,
  membershipCancelledAt: Date,
  paymentMethod: String,
  lastTransactionId: String,
  
  // ID Verification fields
  idVerificationDocuments: [{
    filename: String,
    originalName: String,
    path: String,
    size: Number,
    uploadedAt: { type: Date, default: Date.now }
  }],
  idVerificationSubmittedAt: Date,
  idVerificationApprovedAt: Date,
  
  // Badges system
  badges: [{
    type: String,
    name: String,
    description: String,
    icon: String,
    color: String,
    earnedAt: { type: Date, default: Date.now }
  }],
  
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

// Helper functions to update user statistics
const updateUserStats = async (userId, statType, increment = 1) => {
  try {
    const updateField = {};
    updateField[statType] = increment;
    
    await User.findByIdAndUpdate(
      userId,
      { $inc: updateField },
      { new: true }
    );
  } catch (error) {
    console.error(`Error updating ${statType} for user ${userId}:`, error);
  }
};

const incrementTotalMatches = async (userId) => {
  await updateUserStats(userId, 'totalMatches', 1);
};

const incrementMessageCount = async (userId) => {
  await updateUserStats(userId, 'messagesCount', 1);
};

const incrementProfileViews = async (userId) => {
  await updateUserStats(userId, 'profileViews', 1);
};

// Helper function to add user activity
const addUserActivity = async (userId, type, description, options = {}) => {
  try {
    const activityData = {
      type,
      description,
      timestamp: new Date()
    };

    // Add optional fields
    if (options.relatedUserId) activityData.relatedUserId = options.relatedUserId;
    if (options.relatedUserName) activityData.relatedUserName = options.relatedUserName;
    if (options.pointsEarned) activityData.pointsEarned = options.pointsEarned;

    await User.findByIdAndUpdate(
      userId,
      { 
        $push: { 
          recentActivity: {
            $each: [activityData],
            $slice: -20 // Keep only the last 20 activities
          }
        }
      },
      { new: true }
    );
  } catch (error) {
    console.error(`Error adding user activity for user ${userId}:`, error);
  }
};

// ==================== AUTHENTICATION ROUTES ====================

// Google OAuth authentication
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    
    if (!credential) {
      return res.status(400).json({ 
        success: false, 
        message: 'Google credential is required' 
      });
    }

    // Verify the Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    if (!email || !name) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid Google account data' 
      });
    }

    // Check if user already exists
    let user = await User.findOne({ 
      $or: [{ email }, { googleId }] 
    });

    if (user) {
      // Update existing user
      user.googleId = googleId;
      user.lastActive = new Date();
      if (picture && !user.profilePicture) {
        user.profilePicture = picture;
      }
      await user.save();
      
      // Add login activity
      await addUserActivity(user._id, 'login', 'Signed in to PeThoria');
    } else {
      // Generate a unique username for new users
      const baseUsername = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      let username = baseUsername;
      let counter = 1;
      
      // Check if username exists and generate a unique one
      while (await User.findOne({ username })) {
        username = `${baseUsername}${counter}`;
        counter++;
      }
      
      // Create new user WITHOUT setting location at signup
      user = new User({
        email,
        name,
        username,
        googleId,
        profilePicture: picture,
        points: 50, // Welcome bonus
        lastActive: new Date()
      });
      
      await user.save();
      
      // Add welcome activities for new users
      await addUserActivity(user._id, 'points_earned', 'Welcome bonus points earned!', { pointsEarned: 50 });
      await addUserActivity(user._id, 'profile_updated', 'Profile created successfully');
    }

    // Generate JWT token
    const token = generateToken(user._id, user.email);

    res.json({
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
    });

  } catch (error) {
    console.error('Google OAuth error:', error);
    
    // Handle duplicate key error specifically
    if (error.code === 11000 && error.keyPattern && error.keyPattern.username) {
      console.log('🔄 Duplicate username detected, attempting to generate unique username...');
      
      try {
        // Try to find the user by email or googleId
        const existingUser = await User.findOne({ 
          $or: [{ email }, { googleId }] 
        });
        
        if (existingUser) {
          // User exists, just update and return
          existingUser.googleId = googleId;
          existingUser.lastActive = new Date();
          if (picture && !existingUser.profilePicture) {
            existingUser.profilePicture = picture;
          }
          await existingUser.save();
          
          const token = generateToken(existingUser._id, existingUser.email);
          
          return res.json({
            success: true,
            message: 'Authentication successful',
            token,
            user: {
              id: existingUser._id,
              email: existingUser.email,
              name: existingUser.name,
              profilePicture: existingUser.profilePicture,
              isSubscribed: existingUser.isSubscribed,
              points: existingUser.points
            }
          });
        }
      } catch (retryError) {
        console.error('Retry failed:', retryError);
      }
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
    const cacheKey = `user:${req.user.userId}:profile`;
    
    // Try to get from cache first
    const cachedProfile = await cacheUtils.get(cacheKey);
    if (cachedProfile) {
      console.log('📦 Profile served from Redis cache');
      return res.json(cachedProfile);
    }

    // If not in cache, fetch from database
    const user = await User.findById(req.user.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    const profileData = {
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
    };

    // Cache the profile for 5 minutes
    await cacheUtils.set(cacheKey, profileData, 300);
    console.log('💾 Profile cached in Redis');

    res.json(profileData);

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get profile' 
    });
  }
});

// Get user statistics for dashboard
app.get('/api/profile/stats', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Calculate user statistics
    const stats = {
      points: user.points || 0,
      totalMatches: user.totalMatches || 0,
      messagesCount: user.messagesCount || 0,
      profileViews: user.profileViews || 0,
      memberSince: user.createdAt ? new Date(user.createdAt).getFullYear() : new Date().getFullYear(),
      verificationStatus: user.idVerificationStatus || 'not_submitted',
      badges: user.badges?.length || 0,
      petCount: user.pets?.length || 0,
      lastActive: user.lastActive,
      joinDate: user.createdAt
    };

    res.json({
      success: true,
      stats: stats
    });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get user statistics' 
    });
  }
});

// Get user's recent activity
app.get('/api/profile/activity', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .select('recentActivity')
      .populate('recentActivity.relatedUserId', 'name profilePicture');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Sort activities by timestamp (newest first) and limit to 10
    const activities = (user.recentActivity || [])
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 10)
      .map(activity => ({
        type: activity.type,
        description: activity.description,
        relatedUserName: activity.relatedUserName,
        pointsEarned: activity.pointsEarned,
        timestamp: activity.timestamp,
        timeAgo: getTimeAgo(activity.timestamp)
      }));

    res.json({
      success: true,
      activities: activities
    });

  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get user activity' 
    });
  }
});

// Helper function to format time ago
function getTimeAgo(timestamp) {
  const now = new Date();
  const activityTime = new Date(timestamp);
  const diffInMinutes = Math.floor((now - activityTime) / (1000 * 60));
  
  if (diffInMinutes < 1) return 'Just now';
  if (diffInMinutes < 60) return `${diffInMinutes} minute${diffInMinutes !== 1 ? 's' : ''} ago`;
  
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours} hour${diffInHours !== 1 ? 's' : ''} ago`;
  
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return `${diffInDays} day${diffInDays !== 1 ? 's' : ''} ago`;
  
  return activityTime.toLocaleDateString();
}

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

    // Add profile update activity
    await addUserActivity(userId, 'profile_updated', 'Profile information updated');

    // Clear user cache after profile update
    await cacheUtils.clearUserCache(userId);
    console.log('🗑️ User cache cleared after profile update');

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

    // Add ID verification activity
    await addUserActivity(req.user.userId, 'verification_completed', 'ID verification documents submitted');

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
    
    // Track swipe activity
    if (action === 'like') {
      await addUserActivity(currentUser._id, 'swipe_like', 'Liked a profile');
    } else if (action === 'pass') {
      await addUserActivity(currentUser._id, 'swipe_pass', 'Passed on a profile');
    }
    
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
          
          // Update match statistics for both users
          await incrementTotalMatches(currentUser._id);
          await incrementTotalMatches(targetUserId);
          
          // Add match activities for both users
          await addUserActivity(currentUser._id, 'match', `New match with ${targetUser.name}`, { 
            relatedUserId: targetUserId, 
            relatedUserName: targetUser.name 
          });
          await addUserActivity(targetUserId, 'match', `New match with ${currentUser.name}`, { 
            relatedUserId: currentUser._id, 
            relatedUserName: currentUser.name 
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

// Enhanced filtered matching
app.post('/api/matches/filtered', authenticateToken, async (req, res) => {
  try {
    const { latitude, longitude, filters, userId } = req.body;
    const currentUser = await User.findById(req.user.userId);
    
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user's swiped profiles to exclude them
    const swipedProfileIds = currentUser.swipedProfiles.map(profile => profile.profileId);
    
    // Build query based on filters
    let query = {
      _id: { 
        $ne: currentUser._id,
        $nin: swipedProfileIds
      },
      lastActive: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Active in last 30 days
    };
    
    // Add location-based filtering if coordinates provided
    if (latitude && longitude && filters.radius) {
      const distanceInMeters = filters.radius * 1609.34; // Convert miles to meters
      query.location = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [longitude, latitude]
          },
          $maxDistance: distanceInMeters
        }
      };
    }
    
    // Add city filter
    if (filters.city) {
      query['locationData.city'] = new RegExp(filters.city, 'i');
    }
    
    // Add state filter
    if (filters.state) {
      query['locationData.state'] = filters.state;
    }
    
    // Add pet type filter
    if (filters.petType) {
      query['pets.type'] = filters.petType;
    }
    
    // Add breed filter
    if (filters.breed) {
      query['pets.breed'] = new RegExp(filters.breed.replace('_', ' '), 'i');
    }
    
    // Add age range filter
    if (filters.ageRange) {
      const now = new Date();
      let minAge, maxAge;
      
      switch (filters.ageRange) {
        case 'puppy':
          minAge = 0;
          maxAge = 1;
          break;
        case 'young':
          minAge = 1;
          maxAge = 3;
          break;
        case 'adult':
          minAge = 3;
          maxAge = 7;
          break;
        case 'senior':
          minAge = 7;
          maxAge = 100;
          break;
      }
      
      if (minAge !== undefined && maxAge !== undefined) {
        const maxBirthDate = new Date(now.getFullYear() - minAge, now.getMonth(), now.getDate());
        const minBirthDate = new Date(now.getFullYear() - maxAge, now.getMonth(), now.getDate());
        
        query['pets.birthDate'] = {
          $gte: minBirthDate,
          $lte: maxBirthDate
        };
      }
    }
    
    // Find matching users
    let matchingUsers = await User.find(query).limit(50);
    
    // Sort by real users first if prioritize is enabled
    if (filters.prioritizeRealUsers) {
      matchingUsers.sort((a, b) => {
        const aIsReal = a.isVerified && a.profileImages && a.profileImages.length > 0;
        const bIsReal = b.isVerified && b.profileImages && b.profileImages.length > 0;
        
        if (aIsReal && !bIsReal) return -1;
        if (!aIsReal && bIsReal) return 1;
        return 0;
      });
    }
    
    // Format profiles for frontend
    const formattedMatches = matchingUsers.map(user => {
      const primaryPet = user.pets && user.pets.length > 0 ? user.pets[0] : null;
      const distance = latitude && longitude && user.location ? 
        calculateDistance(latitude, longitude, user.location.coordinates[1], user.location.coordinates[0]) : 
        'Unknown';
        
      return {
        id: user._id,
        name: primaryPet ? primaryPet.name : user.name,
        age: primaryPet && primaryPet.birthDate ? 
          `${Math.floor((Date.now() - primaryPet.birthDate) / (365.25 * 24 * 60 * 60 * 1000))} years` : 
          'Unknown age',
        breed: primaryPet ? primaryPet.breed : 'Unknown breed',
        petType: primaryPet ? primaryPet.type : 'unknown',
        personality: primaryPet ? (primaryPet.personality || []) : [],
        distance: typeof distance === 'number' ? `${distance.toFixed(1)} miles` : distance,
        images: user.profileImages && user.profileImages.length > 0 ? 
          user.profileImages : ['https://images.unsplash.com/photo-1544568100-847a948585b9?w=400'],
        owner: {
          name: user.name,
          isMember: user.membershipType !== 'free',
          isVerified: user.isVerified || false,
          isReal: user.isVerified && user.profileImages && user.profileImages.length > 0
        },
        lastSeen: user.lastActive ? formatTimeAgo(user.lastActive) : 'Unknown',
        isRealUser: user.isVerified && user.profileImages && user.profileImages.length > 0
      };
    });
    
    res.json({
      success: true,
      matches: formattedMatches,
      count: formattedMatches.length,
      filters: filters
    });
    
  } catch (error) {
    console.error('Filtered matching error:', error);
    res.status(500).json({ error: 'Failed to get filtered matches' });
  }
});

// Helper function to calculate distance between two points
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Helper function to format time ago
function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

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

// ==================== PAYMENT PROCESSING ROUTES ====================

// Stripe Payment Processing
app.post('/api/payments/stripe', authenticateToken, async (req, res) => {
  try {
    const { token, plan, amount } = req.body;
    const user = await User.findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Create Stripe charge
    const charge = await stripe.charges.create({
      amount: amount, // Amount in cents
      currency: 'usd',
      source: token,
      description: `PeThoria Premium - ${plan} plan`,
      metadata: {
        userId: user._id.toString(),
        plan: plan,
        email: user.email
      }
    });
    
    if (charge.status === 'succeeded') {
      // Update user membership
      await updateUserMembership(user._id, plan, 'stripe', charge.id);
      
      res.json({
        success: true,
        chargeId: charge.id,
        message: 'Payment successful'
      });
    } else {
      res.status(400).json({ error: 'Payment failed' });
    }
    
  } catch (error) {
    console.error('Stripe payment error:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// PayPal Payment Processing
app.post('/api/payments/paypal', authenticateToken, async (req, res) => {
  try {
    const { orderID, plan, amount } = req.body;
    const user = await User.findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Verify PayPal payment (implement PayPal API verification)
    // For now, we'll assume the payment is valid since PayPal handled it
    
    // Update user membership
    await updateUserMembership(user._id, plan, 'paypal', orderID);
    
    res.json({
      success: true,
      orderId: orderID,
      message: 'PayPal payment successful'
    });
    
  } catch (error) {
    console.error('PayPal payment error:', error);
    res.status(500).json({ error: 'PayPal payment processing failed' });
  }
});

// ==================== MEMBERSHIP MANAGEMENT ROUTES ====================

// Activate membership
app.post('/api/membership/activate', authenticateToken, async (req, res) => {
  try {
    const { plan, amount } = req.body;
    const user = await User.findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update user membership status
    user.membershipType = 'premium';
    user.membershipStatus = 'active';
    user.membershipPlan = plan;
    user.membershipStartDate = new Date();
    
    // Set expiration date based on plan
    if (plan === 'monthly') {
      user.membershipEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    } else if (plan === 'yearly') {
      user.membershipEndDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    } else if (plan === 'lifetime') {
      user.membershipEndDate = new Date('2099-12-31');
    }
    
    // Add premium member badge
    if (!user.badges.some(badge => badge.type === 'premium_member')) {
      user.badges.push({
        type: 'premium_member',
        name: 'Premium Member',
        description: 'Active premium subscription',
        icon: 'fas fa-crown',
        color: '#fbbf24',
        earnedAt: new Date()
      });
    }
    
    await user.save();
    
    // Add activity
    await addUserActivity(user._id, 'membership', `Activated ${plan} premium membership`);
    
    res.json({
      success: true,
      membership: {
        type: user.membershipType,
        status: user.membershipStatus,
        plan: user.membershipPlan,
        startDate: user.membershipStartDate,
        endDate: user.membershipEndDate
      }
    });
    
  } catch (error) {
    console.error('Membership activation error:', error);
    res.status(500).json({ error: 'Failed to activate membership' });
  }
});

// Cancel membership
app.post('/api/membership/cancel', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update membership status
    user.membershipStatus = 'cancelled';
    user.membershipCancelledAt = new Date();
    
    // Remove premium badge
    user.badges = user.badges.filter(badge => badge.type !== 'premium_member');
    
    await user.save();
    
    // Add activity
    await addUserActivity(user._id, 'membership', 'Cancelled premium membership');
    
    res.json({
      success: true,
      message: 'Membership cancelled successfully'
    });
    
  } catch (error) {
    console.error('Membership cancellation error:', error);
    res.status(500).json({ error: 'Failed to cancel membership' });
  }
});

// ==================== CONTACT FORM ROUTES ====================

// Submit contact form
app.post('/api/contact/submit', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, subject, message, newsletter } = req.body;
    
    // Validate required fields
    if (!firstName || !lastName || !email || !subject || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Create contact submission record
    const contactSubmission = {
      firstName,
      lastName,
      email,
      phone,
      subject,
      message,
      newsletter,
      timestamp: new Date(),
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      status: 'pending'
    };
    
    // In a real app, you'd save this to a ContactSubmission model
    // For now, we'll log it and send an email notification
    
    console.log('📧 Contact form submission:', contactSubmission);
    
    // TODO: Send email notification to support team
    // TODO: Add to support ticket system
    
    // If user wants newsletter, add to mailing list
    if (newsletter) {
      // TODO: Add to mailing list service (Mailchimp, etc.)
    }
    
    res.json({
      success: true,
      message: 'Contact form submitted successfully',
      ticketId: `TICKET-${Date.now()}`
    });
    
  } catch (error) {
    console.error('Contact form error:', error);
    res.status(500).json({ error: 'Failed to submit contact form' });
  }
});

// Send confirmation email
app.post('/api/contact/confirmation', async (req, res) => {
  try {
    const { email } = req.body;
    
    // TODO: Send confirmation email
    console.log(`📧 Sending confirmation email to: ${email}`);
    
    res.json({
      success: true,
      message: 'Confirmation email sent'
    });
    
  } catch (error) {
    console.error('Confirmation email error:', error);
    res.status(500).json({ error: 'Failed to send confirmation email' });
  }
});

// ==================== MESSAGING SYSTEM ROUTES ====================

// Send message (only for matched users or premium members)
app.post('/api/messages/send', authenticateToken, async (req, res) => {
  try {
    const { recipientId, message } = req.body;
    const sender = await User.findById(req.user.userId);
    const recipient = await User.findById(recipientId);
    
    if (!sender || !recipient) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if users are matched or if sender is premium
    const isMatched = sender.matches.some(match => 
      match.matchedUserId.toString() === recipientId && match.isActive
    );
    
    const isPremium = sender.membershipType === 'premium' && sender.membershipStatus === 'active';
    
    if (!isMatched && !isPremium) {
      return res.status(403).json({ error: 'Can only message matched users unless you have premium membership' });
    }
    
    // Create message record (implement Message model)
    const messageData = {
      senderId: sender._id,
      recipientId: recipient._id,
      message: message,
      timestamp: new Date(),
      isRead: false
    };
    
    // TODO: Save to Message model
    console.log('💌 Message sent:', messageData);
    
    // Update message count
    await incrementMessageCount(sender._id);
    
    // Add activity
    await addUserActivity(sender._id, 'message', `Sent message to ${recipient.name}`, {
      relatedUserId: recipient._id,
      relatedUserName: recipient.name
    });
    
    res.json({
      success: true,
      message: 'Message sent successfully'
    });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get conversation history
app.get('/api/messages/conversation/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = await User.findById(req.user.userId);
    
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if users are matched or if current user is premium
    const isMatched = currentUser.matches.some(match => 
      match.matchedUserId.toString() === userId && match.isActive
    );
    
    const isPremium = currentUser.membershipType === 'premium' && currentUser.membershipStatus === 'active';
    
    if (!isMatched && !isPremium) {
      return res.status(403).json({ error: 'Can only view conversations with matched users unless you have premium membership' });
    }
    
    // TODO: Fetch messages from Message model
    const messages = []; // Placeholder
    
    res.json({
      success: true,
      messages: messages
    });
    
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// ==================== ID VERIFICATION & BADGES ROUTES ====================

// Submit ID verification
app.post('/api/verification/submit-id', authenticateToken, upload.array('documents', 2), async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'ID documents are required' });
    }
    
    // Process uploaded documents
    const documents = req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      path: file.path,
      size: file.size,
      uploadedAt: new Date()
    }));
    
    // Update user verification status
    user.idVerificationStatus = 'pending';
    user.idVerificationDocuments = documents;
    user.idVerificationSubmittedAt = new Date();
    
    await user.save();
    
    // Add activity
    await addUserActivity(user._id, 'verification_submitted', 'Submitted ID verification documents');
    
    res.json({
      success: true,
      message: 'ID verification submitted successfully',
      status: 'pending'
    });
    
  } catch (error) {
    console.error('ID verification submission error:', error);
    res.status(500).json({ error: 'Failed to submit ID verification' });
  }
});

// Approve ID verification (admin only)
app.post('/api/verification/approve/:userId', authenticateToken, async (req, res) => {
  try {
    // TODO: Add admin authentication check
    
    const user = await User.findById(req.params.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update verification status
    user.idVerificationStatus = 'approved';
    user.idVerificationApprovedAt = new Date();
    user.isVerified = true;
    
    // Add verified badge
    if (!user.badges.some(badge => badge.type === 'verified')) {
      user.badges.push({
        type: 'verified',
        name: 'Verified User',
        description: 'ID verified by PeThoria',
        icon: 'fas fa-shield-check',
        color: '#059669',
        earnedAt: new Date()
      });
    }
    
    // Award verification points
    user.points = (user.points || 0) + 50;
    
    await user.save();
    
    // Add activity
    await addUserActivity(user._id, 'verification_completed', 'ID verification approved! +50 points', {
      pointsEarned: 50
    });
    
    res.json({
      success: true,
      message: 'ID verification approved'
    });
    
  } catch (error) {
    console.error('ID verification approval error:', error);
    res.status(500).json({ error: 'Failed to approve ID verification' });
  }
});

// Helper function to update user membership
async function updateUserMembership(userId, plan, paymentMethod, transactionId) {
  const user = await User.findById(userId);
  
  if (!user) {
    throw new Error('User not found');
  }
  
  user.membershipType = 'premium';
  user.membershipStatus = 'active';
  user.membershipPlan = plan;
  user.membershipStartDate = new Date();
  user.paymentMethod = paymentMethod;
  user.lastTransactionId = transactionId;
  
  // Set expiration date
  if (plan === 'monthly') {
    user.membershipEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  } else if (plan === 'yearly') {
    user.membershipEndDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  } else if (plan === 'lifetime') {
    user.membershipEndDate = new Date('2099-12-31');
  }
  
  // Add premium badge
  if (!user.badges.some(badge => badge.type === 'premium_member')) {
    user.badges.push({
      type: 'premium_member',
      name: 'Premium Member',
      description: 'Active premium subscription',
      icon: 'fas fa-crown',
      color: '#fbbf24',
      earnedAt: new Date()
    });
  }
  
  await user.save();
  
  // Add activity
  await addUserActivity(userId, 'membership', `Activated ${plan} premium membership via ${paymentMethod}`);
}

// ==================== ANALYTICS ENDPOINTS ====================

// Get comprehensive user analytics for dashboard
app.get('/api/analytics/user', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // Calculate user-specific analytics
    const userAnalytics = {
      // Basic stats
      points: user.points || 0,
      totalMatches: user.totalMatches || 0,
      messagesCount: user.messagesCount || 0,
      profileViews: user.profileViews || 0,
      memberSince: user.createdAt ? new Date(user.createdAt).getFullYear() : new Date().getFullYear(),
      verificationStatus: user.idVerificationStatus || 'not_submitted',
      badges: user.badges?.length || 0,
      petCount: user.pets?.length || 0,
      lastActive: user.lastActive,
      joinDate: user.createdAt,
      
      // Engagement metrics
      profileCompleteness: calculateProfileCompleteness(user),
      matchSuccessRate: calculateMatchSuccessRate(user),
      responseRate: calculateResponseRate(user),
      avgResponseTime: calculateAvgResponseTime(user),
      
      // Recent activity counts
      activitiesThisWeek: await getActivityCount(user._id, 7),
      activitiesThisMonth: await getActivityCount(user._id, 30),
      matchesThisWeek: await getMatchCount(user._id, 7),
      matchesThisMonth: await getMatchCount(user._id, 30),
      
      // Growth metrics
      pointsGrowth: await calculatePointsGrowth(user._id),
      matchesGrowth: await calculateMatchesGrowth(user._id),
      viewsGrowth: await calculateViewsGrowth(user._id)
    };

    res.json({
      success: true,
      analytics: userAnalytics
    });

  } catch (error) {
    console.error('Get user analytics error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get user analytics' 
    });
  }
});

// Get platform-wide analytics (for admin/overview)
app.get('/api/analytics/platform', async (req, res) => {
  try {
    // Get platform statistics
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ 
      lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
    });
    const verifiedUsers = await User.countDocuments({ idVerificationStatus: 'approved' });
    const premiumUsers = await User.countDocuments({ membershipType: 'premium' });
    
    // Get recent activity counts
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const newUsersToday = await User.countDocuments({ 
      createdAt: { $gte: today } 
    });
    
    const totalMatches = await User.aggregate([
      { $group: { _id: null, total: { $sum: '$totalMatches' } } }
    ]);
    
    const totalMessages = await User.aggregate([
      { $group: { _id: null, total: { $sum: '$messagesCount' } } }
    ]);
    
    const totalPoints = await User.aggregate([
      { $group: { _id: null, total: { $sum: '$points' } } }
    ]);

    const platformAnalytics = {
      totalUsers,
      activeUsers,
      verifiedUsers,
      premiumUsers,
      newUsersToday,
      totalMatches: totalMatches[0]?.total || 0,
      totalMessages: totalMessages[0]?.total || 0,
      totalPoints: totalPoints[0]?.total || 0,
      avgResponseTime: '2.3min', // This would be calculated from actual message data
      platformHealth: 'Excellent',
      uptime: process.uptime()
    };

    res.json({
      success: true,
      analytics: platformAnalytics
    });

  } catch (error) {
    console.error('Get platform analytics error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get platform analytics' 
    });
  }
});

// Helper functions for analytics calculations
function calculateProfileCompleteness(user) {
  const fields = ['name', 'bio', 'profilePicture', 'location', 'interests', 'favoriteAnimal'];
  const completedFields = fields.filter(field => user[field] && user[field] !== '');
  return Math.round((completedFields.length / fields.length) * 100);
}

function calculateMatchSuccessRate(user) {
  if (!user.totalMatches || !user.totalSwipes) return 0;
  return Math.round((user.totalMatches / user.totalSwipes) * 100);
}

function calculateResponseRate(user) {
  if (!user.messagesReceived || !user.messagesSent) return 0;
  return Math.round((user.messagesSent / user.messagesReceived) * 100);
}

function calculateAvgResponseTime(user) {
  // This would be calculated from actual message timestamps
  // For now, return a reasonable default
  return '2.3min';
}

async function getActivityCount(userId, days) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const user = await User.findById(userId).select('recentActivity');
  if (!user.recentActivity) return 0;
  
  return user.recentActivity.filter(activity => 
    new Date(activity.timestamp) >= startDate
  ).length;
}

async function getMatchCount(userId, days) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const user = await User.findById(userId).select('recentActivity');
  if (!user.recentActivity) return 0;
  
  return user.recentActivity.filter(activity => 
    activity.type === 'match' && new Date(activity.timestamp) >= startDate
  ).length;
}

async function calculatePointsGrowth(userId) {
  // This would calculate points growth over time
  // For now, return a reasonable default
  return '+12%';
}

async function calculateMatchesGrowth(userId) {
  // This would calculate matches growth over time
  // For now, return a reasonable default
  return '+8%';
}

async function calculateViewsGrowth(userId) {
  // This would calculate profile views growth over time
  // For now, return a reasonable default
  return '+15%';
}

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

// Function to fix usernames on server startup
async function fixUsernamesOnStartup() {
  try {
    console.log('🔧 Checking for users with null usernames...');
    
    const usersWithNullUsernames = await User.find({
      $or: [
        { username: null },
        { username: { $exists: false } }
      ]
    });
    
    if (usersWithNullUsernames.length === 0) {
      console.log('✅ No users with null usernames found. Database is clean!');
      return;
    }
    
    console.log(`📊 Found ${usersWithNullUsernames.length} users with null usernames. Fixing...`);
    
    for (const user of usersWithNullUsernames) {
      try {
        const baseUsername = user.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        let username = baseUsername;
        let counter = 1;
        
        while (await User.findOne({ username, _id: { $ne: user._id } })) {
          username = `${baseUsername}${counter}`;
          counter++;
        }
        
        await User.findByIdAndUpdate(user._id, { username });
        console.log(`✅ Fixed user ${user.email}: ${user.name} -> ${username}`);
        
      } catch (error) {
        console.error(`❌ Error fixing user ${user.email}:`, error.message);
      }
    }
    
    console.log('🎉 Username fix completed!');
    
  } catch (error) {
    console.error('❌ Error during username fix:', error);
  }
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`MongoDB connected: ${mongoose.connection.readyState === 1 ? 'Yes' : 'No'}`);
  console.log('🚀 PeThoria Server with Authentication ready!');
  console.log('📱 Google OAuth integration enabled');
  console.log('🌍 Location-based matching system ready!');
  
  // Run username fix on startup
  await fixUsernamesOnStartup();
}); 
