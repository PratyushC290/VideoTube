import { asyncHandler } from "../utils/asyncHandler.js";
import { apiError } from "../utils/apiError.js"
import { User } from "../models/user.models.js";
import { uploadOnCloudinary } from "../utils/cloudinary.js";
import { apiResponse } from "../utils/apiResponse.js";
import { deleteFromCloudinary } from "../utils/cloudinary.js";
import jwt from 'jsonwebtoken'

const generateAccessAndRefreshToken = async(userId) => {
    try {
        user = await User.findById(userId)
        if (!user) {
            throw new apiError(404, "User not found for generating tokens");
        }
        const accessToken = user.generateAccessToken()
        const refreshToken = user.generateRefreshToken()
    
        user.refreshToken = refreshToken
        await user.save({validateBeforeSave: false})
        return {accessToken, refreshToken}
    } catch (error) {
        throw new apiError(500, "Error in generating tokens")
    }
}

const registerUser = asyncHandler( async(req , res ) => {
    const { fullname, email, username, password } = req.body;

    if (
        [fullname, username, email, password].some((field) => field?.trim()==="")
    ){
        throw new apiError(400, "All fields are required")
    }

    const existedUser = await User.findOne({
        $or: [{username}, {email}]
    })

    if (existedUser) {
        throw new apiError(409, "A user already exists with the same username or email")
    }

    const avatarLocalPath = req.files?.avatar?.[0]?.path
    const coverLocalPath = req.files?.coverImage?.[0]?.path

    if (!avatarLocalPath) {
        throw new apiError(400, "Avatar file is missing")
    }

    // const avatar = await uploadOnCloudinary(avatarLocalPath)
    // let coverImage = ""
    // if (coverLocalPath) {
    //     coverImage = await uploadOnCloudinary(coverLocalPath)
    // }

    let avatar;
    try {
        avatar = await uploadOnCloudinary(avatarLocalPath)
        console.log("Uploaded avatar", avatar)
    } catch (error) {
        console.log("Error uploading avatar", error)
        throw new apiError(500, "Failed to upload avatar")
    }

    let coverImage;
    try {
        coverImage = await uploadOnCloudinary(coverLocalPath)
        console.log("Uploaded coverImage", coverImage)
    } catch (error) {
        console.log("Error uploading coverImage", error)
        throw new apiError(500, "Failed to upload coverImage")
    }

    try {
        const user = await User.create({
            fullname,
            avatar: avatar.url,
            coverImage: coverImage?.url||"",
            email,
            password,
            username: username.toLowerCase()
        })
    
        const createdUser = await User.findById(user._id ).select(
            "-password -refreshToken"
        )
    
        if (!createdUser) {
            throw new apiError(500, "Something went wrong while registering the user")
        }
    
        return res
            .status(201)
            .json(new apiResponse(201, createdUser, "User registered successfully"))
    } catch (error) {
        console.log("User creation failed", error)

        if (avatar) {
            await deleteFromCloudinary(avatar.public_id)
        }
        if (coverImage) {
            await deleteFromCloudinary(coverImage.public_id)
        }
        throw new apiError(500, "Something went wrong while registering the user and images were deleted")
    }
})

const loginUser = asyncHandler(async (req, res ) => {
    const {email, username, password} = req.body

    if (!email) {
        throw new apiError(400, "Email is required")
    }

    const user = await User.findOne({
        $or: [{username}, {email}]
    })

    if (!user) {
        throw new apiError(404, "User not found")
    }

    const isPasswordValid = await user.isPasswordCorrect(password)
    if (!isPasswordValid){
        throw new apiError(401, "Invalid credentials")
    }

    const {accessToken, refreshToken} = await generateAccessAndRefreshToken(user._id)

    const loggedInUser = await User.findById(user._id).select(
        "-password -refreshToken"
    )

    if (!loggedInUser) {
        throw new apiError(404, "logged in user not found")
    }

    const options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production"
    }

    return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json( new apiResponse (
            200, 
            { user: loggedInUser, accessToken, refreshToken }, 
            "User logged in successfully"
        ))
})

const logoutUser = asyncHandler( async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $set: {
                refreshToken: undefined,
            }
        },
        {new:true}
    )
    const options = {
            httpOnly: true,
            secure: process.env.NODE_ENV==="production"
    }
    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json( new apiResponse (200, {}, "User logged out successfully"))

})

const refreshAccessToken = asyncHandler( async(req, res) =>{
    const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken
    if (!incomingRefreshToken) {
        throw new apiError(401, "Refresh token is required")
    }
    
    try {
        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        )
        const user = await User.findById(decodedToken?._id)
        if (!user) {
            throw new apiError(401, "Invalid refresh token")
        }  
        if (incomingRefreshToken !== user?.refreshToken) {
            throw new apiError(401, "Invalid refresh token")
        }

        const options = {
            httpOnly: true,
            secure: process.env.NODE_ENV==="production"
        }

        const {accessToken, refreshToken: newRefreshToken} = await generateAccessAndRefreshToken(user._id)
        return res
            .status(200)
            .cookie("accessToken", accessToken, options)
            .cookie("refreshToken", newRefreshToken, options)
            .json( new apiResponse (
                200, 
                { accessToken, refreshToken: newRefreshToken }, 
                "Access token refreshed successfully"
            ))
    } catch (error) {
        throw new apiError(500, "Something went wrong while refreshing access token")
    }
})

const changeCurrentPassword = asyncHandler( async (req, res) => {
    const {oldPassword, newPassword} = req.body
    const user = await User.findById(req.user?._id)
    const isPasswordValid = await user.isPasswordCorrect(oldPassword)
    if (!isPasswordValid) {
        throw new apiError(401, "Old password is incorrect")
    }
    user.password = newPassword

    await user.save({validateBeforeSave: false})
    return res
        .status(200)
        .json(new apiResponse(200, {}, "Password changed successfully"))
})
const getCurrentUser = asyncHandler( async (req, res) => {
    return res.status(200).json(new apiResponse(200, req.user, "Current user details"))
})
const updateAccountDetails = asyncHandler( async (req, res) => {
    const {fullname, email} = req.body
    if (!fullname || !email) {
        throw new apiError(400, "Fullname and email are required fields")
    }
    User.findByIdAndUpdate(
        req.user?.id,
        {
            $set: {
                fullname,
                email: email
            }
        },
        {new:true}
    ).select("-password -refreshToken")

    return res.status(200).json(new apiResponse(200,user,"Fullname and email updated"))
})
const updateUserAvatar = asyncHandler( async (req, res) => {
    const avatarLocalPath = req.file?.path
    if (!avatarLocalPath){
        throw new apiError(400, "File is required")
    }
    const avatar = await uploadOnCloudinary(avatarLocalPath)
    if (!avatar.url){
        throw new apiError(500, "Something went wrong while uploading the avatar")
    }

    await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                avatar: avatar.url
            }
        },
        {new:true}
    ).select("-password -refreshToken")
    res
        .status(200)
        .json(new apiResponse(200, user, "Avatar updated successfully"))
})
const updateUserCoverImage = asyncHandler( async (req, res) => {
    const coverLocalPath = req.file?.path
    if (!coverLocalPath){
        throw new apiError(400, "File is required")
    }
    const coverImage = await uploadOnCloudinary(coverLocalPath)
    if (!coverImage.url){
        throw new apiError(500, "Something went wrong while uploading the coverImage")
    }
    await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                coverImage: coverImage.url
            }
        },
        {new:true}
    ).select("-password -refreshToken")
    res
        .status(200)
        .json(new apiResponse(200, user, "Cover image updated successfully"))
})

export {
    registerUser,
    loginUser,
    refreshAccessToken,
    logoutUser,
    changeCurrentPassword,
    getCurrentUser,
    updateAccountDetails,
    updateUserAvatar,
    updateUserCoverImage
}