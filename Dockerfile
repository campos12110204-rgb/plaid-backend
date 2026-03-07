# Use official Node.js 20 LTS image
FROM node:20

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first (for caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the project files
COPY . .

# Expose the port your app uses
EXPOSE 3000

# Start the backend server
CMD ["node", "server.js"]
