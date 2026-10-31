# Build stage: Vite inlines VITE_* vars at build time, so the API URLs are
# build args (docker-compose sets them). They are the URLs the *browser* calls,
# i.e. the services' published host ports, not in-network hostnames.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_EVENTS_API_URL=http://localhost:4001/api/events
ARG VITE_AUTH_API_URL=http://localhost:4002/api/auth
ARG VITE_USERS_API_URL=http://localhost:4002/api/users
ARG VITE_VENUES_API_URL=http://localhost:4003/api/venues
ARG VITE_NOTIFICATIONS_API_URL=http://localhost:4004/api/notifications
ARG VITE_EQUIPMENT_API_URL=http://localhost:4005/api/equipment-requests
ARG VITE_CHAT_API_URL=http://localhost:4006/api/chat
ARG VITE_REGISTRATION_API_URL=http://localhost:4007/api/registrations
ENV VITE_EVENTS_API_URL=$VITE_EVENTS_API_URL \
    VITE_AUTH_API_URL=$VITE_AUTH_API_URL \
    VITE_USERS_API_URL=$VITE_USERS_API_URL \
    VITE_VENUES_API_URL=$VITE_VENUES_API_URL \
    VITE_NOTIFICATIONS_API_URL=$VITE_NOTIFICATIONS_API_URL \
    VITE_EQUIPMENT_API_URL=$VITE_EQUIPMENT_API_URL \
    VITE_CHAT_API_URL=$VITE_CHAT_API_URL \
    VITE_REGISTRATION_API_URL=$VITE_REGISTRATION_API_URL
RUN npm run build

# Runtime stage: static files behind nginx, with history-mode SPA fallback.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
