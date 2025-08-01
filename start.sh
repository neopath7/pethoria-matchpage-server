#!/bin/bash

# PeThoria Location-Based Matching Server Startup Script

echo "🐾 Welcome to PeThoria Location-Based Matching System!"
echo "================================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js (v14 or higher) first."
    echo "Visit: https://nodejs.org/"
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env file not found!"
    echo "Please create a .env file with your environment variables."
    echo "You can copy from .env.example if it exists."
    echo ""
    read -p "Do you want to continue anyway? (y/n): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
if npm install; then
    echo "✅ Dependencies installed successfully!"
else
    echo "❌ Failed to install dependencies. Please check the error messages above."
    exit 1
fi

# Start the server
echo ""
echo "🚀 Starting PeThoria server..."
echo "Server will be available at: http://localhost:8000"
echo "API endpoints will be available at: http://localhost:8000/api/"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Check if we're in development or production mode
if [ "$NODE_ENV" = "production" ]; then
    npm start
else
    echo "🔧 Starting in development mode..."
    npm run dev
fi 
