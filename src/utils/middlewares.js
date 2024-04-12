import jwt from "jsonwebtoken";

const jwt_secret_key = "perfect_peace";

const undefinedEndpoint = (req, res, next) => {
    const err = new Error("Page requesting not found");
    res.status(404);
    next(err)
}


const authenticateUser = (req, res, next) => {

    try{
        const authHeader = req.headers.authorization;
        if (!authHeader){
            res.status(403);
            throw Error("No authorization header");
        }

        const token = authHeader.split(" ")[1];
        if (!token){
            res.status(403);
            throw Error("User not authorized");
        }

        const user = jwt.verify(token, jwt_secret_key);

        req.params.user = user;

        next();

    }catch(err){
        next(err);
    }
}


const authenticateManagementUser = (req, res, next) => {

    try{
        const authHeader = req.headers.authorization;
        if (!authHeader){
            res.status(403);
            throw Error("No authorization header");
        }

        const token = authHeader.split(" ")[1];
        if (!token){
            res.status(403);
            throw Error("User not authorized");
        }

        const user = jwt.verify(token, jwt_secret_key);

        req.params.user = user;

        next();

    }catch(err){
        next(err);
    }
}

let requestCount = 0;
const countRequests = (req, res, next) => {
  requestCount++;
  next();
};

export {
    authenticateUser,
    undefinedEndpoint,

    authenticateManagementUser,

    countRequests,
    requestCount,
}