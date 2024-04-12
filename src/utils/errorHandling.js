const errorHandler = (err, req, res, next) => {
    const errMsg = {
        message: err.message
    };
    const code = res.statusCode === 200 ? 500 : res.statusCode;

    console.error(err);
    res.status(code).json(errMsg);
}


export {
    errorHandler
};