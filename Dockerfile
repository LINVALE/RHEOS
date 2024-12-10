FROM node:19-bullseye-slim
USER root
RUN usermod -a -G sudo node
RUN usermod -a -G audio node
RUN apt-get update && apt-get install -yq  --no-install-recommends squeezelite  && apt-get clean
WORKDIR /home/node
COPY . /home/node
COPY --chown=node:node . .
RUN npm ci && npm cache clean --force
RUN chmod a+rwx ./UPnP/Bin
RUN chmod a+rwx ./UPnP/Profiles
EXPOSE 1255
EXPOSE 1256
EXPOSE 9000
EXPOSE 9330
EXPOSE 3483
EXPOSE 80
USER node
CMD [ "node", "app.mjs","-l"]


